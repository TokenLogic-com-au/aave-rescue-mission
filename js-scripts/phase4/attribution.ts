import fs from 'fs';
import path from 'path';
import {
  createPublicClient,
  formatUnits,
  getAddress,
  http,
  isAddressEqual,
  parseAbiItem,
  toEventSelector,
  zeroAddress,
  type Address,
  type Hash,
} from 'viem';
import {Holding, HoldingKind} from './balances';
import {assertChainId, ChainConfig, chainById, envReaders, rpcEnv} from './chains';
import {compareAddresses, sha256, writeCanonical} from './canonical';
import {ChainFailure, chainFailure, runCli} from './cli';
import {FilteredBalances} from './filter';
import {PipelineInputs, readInputs} from './inputs';
import {poolOf} from './inventory';
import {ChainRange} from './ranges';
import {SURPLUS_PATH, SURPLUS_SQL_PATH, SurplusHolding, SurplusManifest} from './surplus';
import {shareUsd, transferCents} from './usd';
import {Inventory} from '../common/types';

/**
 * Attribution: who sent the tokens found by balance discovery. Runs over the filtered holdings
 * (a group below the threshold cannot contain an eligible wallet). Three kinds have no
 * legitimate inbound flow, so every Transfer into the holder over the pinned window is a
 * candidate and comes straight from RPC logs: aTokens held by themselves, other market tokens
 * in an aToken, anything in a Pool. Underlying in its own aToken needs the Dune query in
 * surplus.ts first; its rows are re-verified here against transaction receipts. Without a
 * surplus file those holdings are recorded as deferred.
 */

// ---- Output shapes --------------------------------------------------------------------------

/** `dust`: below the per-transfer USD floor at the pinned oracle price; counted, never verified or paid. */
export type Outcome = 'candidate' | 'manual_review' | 'dust';

export type Transfer = {
  block: number;
  txHash: Hash;
  logIndex: number;
  /** ERC-20 Transfer `from`: the default beneficiary identity. */
  tokenFrom: Address;
  /** Transaction signer: evidence only, never a substitute for tokenFrom. Null for dust (receipt not read). */
  txFrom: Address | null;
  /** Transaction target; the token itself for a direct transfer, a router or Safe otherwise. Null for dust. */
  txTo: Address | null;
  amount: string;
  outcome: Outcome;
  reason?: string;
};

export type Wallet = {
  tokenFrom: Address;
  amount: string;
  amountFormatted: string;
  /** Proportional share of the group's USD value, an annotation only. */
  valueUsd?: string;
  transfers: number;
};

export type Outflow = {block: number; txHash: Hash; logIndex: number; to: Address; amount: string};

export type Evidence =
  | {source: 'rpc-logs'}
  | {source: 'dune-anti-join'; executionIds: string[]; sqlSha256: string; receiptsVerified: number};

export type Reconciliation = {
  candidates: string;
  review: string;
  dust: string;
  outflows: string;
  /** balance - (candidates + review + dust - outflows). */
  delta: string;
  /** `reconciled` only when nothing needs review, nothing left the holder, and the delta is zero. */
  status: 'reconciled' | 'review';
  note?: string;
};

export type Group = {
  chainId: number;
  chainAlias: string;
  market: string;
  kind: HoldingKind;
  holder: Address;
  holderSymbol: string;
  token: Address;
  tokenSymbol: string;
  decimals: number;
  fromBlock: number;
  toBlock: number;
  /** For underlying-in-own-atoken the surplus over the virtual balance, else the balance. */
  balance: string;
  balanceUsd?: string;
  evidence: Evidence;
  /** Candidates first, then manual review, then dust; largest first within each. */
  transfers: Transfer[];
  /** Candidates aggregated by tokenFrom, largest first. */
  wallets: Wallet[];
  /** Transfers out of the holder in the window; not tracked for the surplus kind. */
  outflows: Outflow[];
  reconciliation: Reconciliation;
};

export type AttributionManifest = {
  filteredSha256: string;
  runSha256: string;
  /** Per-transfer floor in USD at the pinned oracle price; unpriced holdings verify everything. */
  minTransferUsd: number;
  /** Present when surplus-transfers.json was used; ties the Dune rows to this run. */
  surplus?: {sha256: string; sqlSha256: string};
  groups: Group[];
  /** Surplus holdings, only when no surplus file was given. */
  deferred: Holding[];
  failures: ChainFailure[];
};

const ATTRIBUTION_PATH = path.resolve(__dirname, 'data/attribution.json');

// ---- Chain reads ----------------------------------------------------------------------------

const TRANSFER = parseAbiItem(
  'event Transfer(address indexed from, address indexed to, uint256 value)'
);
export const TRANSFER_TOPIC = toEventSelector(TRANSFER);

export type RawTransfer = {
  block: bigint;
  txHash: Hash;
  logIndex: number;
  from: Address;
  to: Address;
  value: bigint;
};

export type Receipt = {
  from: Address;
  to: Address | null;
  block: bigint;
  logs: {address: Address; topics: readonly Hash[]; data: Hash; logIndex: number}[];
};

/** Log and receipt reads over a block range. Needs no historical state. */
export type LogReader = {
  chainId(): Promise<number>;
  /** Canonical Transfer logs of `token` where `to` (or `from`) is `party`, in [fromBlock, toBlock]. */
  transfers(
    token: Address,
    side: 'to' | 'from',
    party: Address,
    fromBlock: bigint,
    toBlock: bigint
  ): Promise<RawTransfer[]>;
  receipt(hash: Hash): Promise<Receipt>;
};

/** Providers cap eth_getLogs by span and result size; halve the range on any error until it is one block. */
export async function adaptiveLogs<T>(
  fetch: (from: bigint, to: bigint) => Promise<T[]>,
  from: bigint,
  to: bigint
): Promise<T[]> {
  try {
    return await fetch(from, to);
  } catch (error) {
    if (from >= to) throw error;
    const mid = (from + to) / 2n;
    return [
      ...(await adaptiveLogs(fetch, from, mid)),
      ...(await adaptiveLogs(fetch, mid + 1n, to)),
    ];
  }
}

function viemLogReader(url: string): LogReader {
  const client = createPublicClient({transport: http(url, {batch: false, timeout: 60_000})});
  const receipts = new Map<Hash, Receipt>();
  return {
    chainId: () => client.getChainId(),
    transfers: (token, side, party, fromBlock, toBlock) =>
      adaptiveLogs(
        async (from, to) =>
          (
            await client.getLogs({
              address: token,
              event: TRANSFER,
              args: side === 'to' ? {to: party} : {from: party},
              fromBlock: from,
              toBlock: to,
            })
          )
            .filter((l) => !l.removed)
            .map((l) => ({
              block: l.blockNumber,
              txHash: l.transactionHash,
              logIndex: l.logIndex,
              from: getAddress(l.args.from!),
              to: getAddress(l.args.to!),
              value: l.args.value!,
            })),
        fromBlock,
        toBlock
      ),
    receipt: async (hash) => {
      let r = receipts.get(hash);
      if (!r) {
        const t = await client.getTransactionReceipt({hash});
        r = {
          from: getAddress(t.from),
          to: t.to ? getAddress(t.to) : null,
          block: t.blockNumber,
          logs: t.logs.map((l) => ({
            address: getAddress(l.address),
            topics: l.topics,
            data: l.data,
            logIndex: l.logIndex,
          })),
        };
        receipts.set(hash, r);
      }
      return r;
    },
  };
}

export type ReaderFactory = (chain: ChainConfig) => LogReader | undefined;

export const envReaderFactory = (env: NodeJS.ProcessEnv = process.env): ReaderFactory =>
  envReaders(viemLogReader, env);

// ---- Classification and reconciliation ------------------------------------------------------

const isDust = (t: RawTransfer, holding: Holding, minTransferUsd: number): boolean =>
  holding.priceUsd !== undefined &&
  transferCents(t.value, holding.decimals, holding.priceUsd) < BigInt(minTransferUsd * 100);

/** Pool and aTokens of one market, lower-cased; a transfer from them is not a user mistake. */
function protocolAddresses(inventory: Inventory, chainId: number, market: string): Set<string> {
  return new Set(
    inventory.targets
      .filter((t) => t.chainId === chainId && t.market === market)
      .map((t) => t.target.toLowerCase())
  );
}

function classify(
  t: RawTransfer,
  txFrom: Address,
  protocol: Set<string>
): Pick<Transfer, 'outcome' | 'reason'> {
  const review = (reason: string) => ({outcome: 'manual_review' as const, reason});
  if (t.from === zeroAddress) return review('minted directly into the holder');
  if (protocol.has(t.from.toLowerCase()))
    return review('sent by a protocol contract of this market');
  if (t.value === 0n) return review('zero-value transfer');
  if (!isAddressEqual(t.from, txFrom))
    return review('sender is not the transaction signer: router, Safe or relayer');
  return {outcome: 'candidate'};
}

const byPosition = (a: RawTransfer, b: RawTransfer) =>
  Number(a.block - b.block) || a.logIndex - b.logIndex;

const RANK: Record<Outcome, number> = {candidate: 0, manual_review: 1, dust: 2};
const byOutcomeThenSize = (a: Transfer, b: Transfer) =>
  RANK[a.outcome] - RANK[b.outcome] ||
  (BigInt(a.amount) > BigInt(b.amount) ? -1 : BigInt(a.amount) < BigInt(b.amount) ? 1 : 0) ||
  a.block - b.block ||
  a.logIndex - b.logIndex;

/** A transfer with its receipt evidence, or dust with none. */
type Inbound = RawTransfer & ({txFrom: Address; txTo: Address | null} | {dust: true});

function toTransfer(t: Inbound, protocol: Set<string>, minTransferUsd: number): Transfer {
  return {
    block: Number(t.block),
    txHash: t.txHash,
    logIndex: t.logIndex,
    tokenFrom: t.from,
    txFrom: 'dust' in t ? null : t.txFrom,
    txTo: 'dust' in t ? null : t.txTo,
    amount: t.value.toString(),
    ...('dust' in t
      ? {
          outcome: 'dust' as const,
          reason: `below ${minTransferUsd} USD at the pinned price; not verified`,
        }
      : classify(t, t.txFrom, protocol)),
  };
}

/** Candidates summed per sender, largest first. */
function aggregateWallets(transfers: Transfer[], holding: Holding): Wallet[] {
  const byWallet = new Map<Address, {amount: bigint; transfers: number}>();
  for (const t of transfers) {
    if (t.outcome !== 'candidate') continue;
    const w = byWallet.get(t.tokenFrom) ?? {amount: 0n, transfers: 0};
    w.amount += BigInt(t.amount);
    w.transfers += 1;
    byWallet.set(t.tokenFrom, w);
  }
  const balance = BigInt(holding.amount);
  return [...byWallet.entries()]
    .sort(([a, x], [b, y]) =>
      x.amount > y.amount ? -1 : x.amount < y.amount ? 1 : compareAddresses(a, b)
    )
    .map(([tokenFrom, w]) => ({
      tokenFrom,
      amount: w.amount.toString(),
      amountFormatted: formatUnits(w.amount, holding.decimals),
      ...(holding.valueUsd !== undefined && balance > 0n
        ? {valueUsd: shareUsd(holding.valueUsd, w.amount, balance)}
        : {}),
      transfers: w.transfers,
    }));
}

/** Totals against the balance; anything unexplained or unresolved keeps the group in review. */
function reconcile(
  holding: Holding,
  transfers: Transfer[],
  outflowTotal: bigint,
  rebasing: boolean
): Reconciliation {
  const sum = (outcome: Outcome) =>
    transfers.filter((t) => t.outcome === outcome).reduce((n, t) => n + BigInt(t.amount), 0n);
  const [candidates, review, dust] = [sum('candidate'), sum('manual_review'), sum('dust')];
  const delta = BigInt(holding.amount) - (candidates + review + dust - outflowTotal);
  const surplus = holding.kind === 'underlying-in-own-atoken';
  const reviewCount = transfers.filter((t) => t.outcome === 'manual_review').length;

  const notes: string[] = [];
  if (holding.note) notes.push(`balance discovery: ${holding.note}`);
  if (reviewCount) notes.push(`${reviewCount} transfer(s) need manual review`);
  if (outflowTotal > 0n)
    notes.push(
      'tokens left the holder in the window: which senders were already refunded is unresolved'
    );
  if (delta > 0n)
    notes.push(
      surplus
        ? 'surplus exceeds attributed transfers: transfers before the window, or surplus not created by direct transfers'
        : rebasing
          ? 'balance exceeds transfers: accrued interest on the aToken, or transfers before the window'
          : 'balance exceeds transfers: transfers before the window or unexplained inflow'
    );
  if (delta < 0n)
    notes.push(
      surplus
        ? 'attributed transfers exceed the surplus: part was already withdrawn through the Pool or rescued (outflows are not tracked for this kind)'
        : 'balance below transfers: unexplained outflow'
    );

  return {
    candidates: candidates.toString(),
    review: review.toString(),
    dust: dust.toString(),
    outflows: outflowTotal.toString(),
    delta: delta.toString(),
    status:
      delta === 0n && outflowTotal === 0n && reviewCount === 0 && !holding.note
        ? 'reconciled'
        : 'review',
    ...(notes.length ? {note: notes.join('; ')} : {}),
  };
}

/** Classification, per-wallet aggregation and reconciliation, shared by both evidence sources. */
function assembleGroup(
  chain: ChainConfig,
  holding: Holding,
  range: Pick<ChainRange, 'fromBlock' | 'toBlock'>,
  protocol: Set<string>,
  inbound: Inbound[],
  outbound: RawTransfer[],
  evidence: Evidence,
  minTransferUsd: number
): Group {
  const transfers = inbound
    .map((t) => toTransfer(t, protocol, minTransferUsd))
    .sort(byOutcomeThenSize);
  const outflows: Outflow[] = outbound.sort(byPosition).map((t) => ({
    block: Number(t.block),
    txHash: t.txHash,
    logIndex: t.logIndex,
    to: t.to,
    amount: t.value.toString(),
  }));
  const outflowTotal = outbound.reduce((n, t) => n + t.value, 0n);
  return {
    chainId: chain.chainId,
    chainAlias: chain.alias,
    market: holding.market,
    kind: holding.kind,
    holder: holding.holder,
    holderSymbol: holding.holderSymbol,
    token: holding.token,
    tokenSymbol: holding.tokenSymbol,
    decimals: holding.decimals,
    fromBlock: range.fromBlock,
    toBlock: range.toBlock,
    balance: holding.amount,
    ...(holding.valueUsd !== undefined ? {balanceUsd: holding.valueUsd} : {}),
    evidence,
    transfers,
    wallets: aggregateWallets(transfers, holding),
    outflows,
    reconciliation: reconcile(
      holding,
      transfers,
      outflowTotal,
      protocol.has(holding.token.toLowerCase())
    ),
  };
}

// ---- Evidence sources -----------------------------------------------------------------------

/** RPC logs in and out of the holder; every inbound transfer is a candidate until classified. */
export async function scanGroup(
  chain: ChainConfig,
  reader: LogReader,
  holding: Holding,
  range: Pick<ChainRange, 'fromBlock' | 'toBlock'>,
  protocol: Set<string>,
  minTransferUsd: number
): Promise<Group> {
  const from = BigInt(range.fromBlock);
  const to = BigInt(range.toBlock);
  const [inbound, outbound] = await Promise.all([
    reader.transfers(holding.token, 'to', holding.holder, from, to),
    reader.transfers(holding.token, 'from', holding.holder, from, to),
  ]);
  const withSigner: Inbound[] = [];
  for (const t of inbound.sort(byPosition)) {
    if (isDust(t, holding, minTransferUsd)) {
      withSigner.push({...t, dust: true});
      continue;
    }
    const r = await reader.receipt(t.txHash);
    withSigner.push({...t, txFrom: r.from, txTo: r.to});
  }
  return assembleGroup(
    chain,
    holding,
    range,
    protocol,
    withSigner,
    outbound,
    {source: 'rpc-logs'},
    minTransferUsd
  );
}

const topicAddress = (topic: Hash): Address => getAddress(`0x${topic.slice(-40)}`);

/**
 * Dune rows for a surplus holding, each non-dust row proven by its receipt: the Transfer log
 * exists as claimed, signer and target match, and the transaction emitted nothing from the Pool.
 * Any contradiction fails the chain rather than the row, since it means the query or the
 * warehouse is off. Rows under the per-transfer floor are recorded as dust without a receipt read.
 */
export async function verifySurplusGroup(
  chain: ChainConfig,
  reader: LogReader,
  holding: Holding,
  entry: SurplusHolding,
  pool: Address,
  protocol: Set<string>,
  sqlSha256: string,
  minTransferUsd: number
): Promise<Group> {
  const inbound: Inbound[] = [];
  const seen = new Set<string>();
  let verified = 0;
  for (const row of entry.rows) {
    const where = `${chain.alias} ${row.txHash} log ${row.logIndex}`;
    const key = `${row.txHash}:${row.logIndex}`;
    if (seen.has(key)) throw new Error(`${where}: listed twice in surplus-transfers.json`);
    seen.add(key);
    if (row.block < entry.fromBlock || row.block > entry.toBlock)
      throw new Error(`${where}: block ${row.block} outside ${entry.fromBlock}..${entry.toBlock}`);
    const raw: RawTransfer = {
      block: BigInt(row.block),
      txHash: row.txHash,
      logIndex: row.logIndex,
      from: row.tokenFrom,
      to: holding.holder,
      value: BigInt(row.amount),
    };
    if (isDust(raw, holding, minTransferUsd)) {
      inbound.push({...raw, dust: true});
      continue;
    }
    const r = await reader.receipt(row.txHash);
    if (r.block !== raw.block) throw new Error(`${where}: receipt block differs from Dune`);
    const log = r.logs.find((l) => l.logIndex === row.logIndex);
    const isClaimedTransfer =
      log !== undefined &&
      isAddressEqual(log.address, holding.token) &&
      log.topics[0] === TRANSFER_TOPIC &&
      log.topics.length === 3 &&
      isAddressEqual(topicAddress(log.topics[1]), row.tokenFrom) &&
      isAddressEqual(topicAddress(log.topics[2]), holding.holder) &&
      BigInt(log.data) === raw.value;
    if (!isClaimedTransfer)
      throw new Error(`${where}: receipt does not contain the Transfer Dune reported`);
    const sameParties =
      isAddressEqual(r.from, row.txFrom) &&
      (r.to === null ? row.txTo === null : row.txTo !== null && isAddressEqual(r.to, row.txTo));
    if (!sameParties) throw new Error(`${where}: receipt signer or target differs from Dune`);
    if (r.logs.some((l) => isAddressEqual(l.address, pool)))
      throw new Error(`${where}: transaction emitted a Pool log`);
    inbound.push({...raw, txFrom: r.from, txTo: r.to});
    verified += 1;
  }
  return assembleGroup(
    chain,
    holding,
    {fromBlock: entry.fromBlock, toBlock: entry.toBlock},
    protocol,
    inbound,
    [],
    {
      source: 'dune-anti-join',
      executionIds: entry.executions.map((e) => e.id),
      sqlSha256,
      receiptsVerified: verified,
    },
    minTransferUsd
  );
}

// ---- Run ------------------------------------------------------------------------------------

export type SurplusInput = {manifest: SurplusManifest; text: string; sqlText: string};

/** The surplus file must come from this filtered file and the SQL template as committed, and be final. */
function verifySurplus(inputs: PipelineInputs, surplus: SurplusInput): void {
  if (surplus.manifest.filteredSha256 !== sha256(inputs.filteredText))
    throw new Error(
      'inputs do not chain: surplus-transfers.json was built from another filtered file'
    );
  if (surplus.manifest.sqlSha256 !== sha256(surplus.sqlText))
    throw new Error(
      'inputs do not chain: surplus-transfers.json was built from another surplus.sql'
    );
  if (surplus.manifest.failures.length)
    throw new Error('surplus-transfers.json is not final: it has failures');
}

/** Priced and unpriced filtered holdings by chain id, ascending. */
function holdingsByChain(filtered: FilteredBalances): [number, Holding[]][] {
  const out = new Map<number, Holding[]>();
  for (const h of [...filtered.chains.flatMap((c) => c.holdings), ...filtered.unpriced])
    out.set(h.chainId, [...(out.get(h.chainId) ?? []), h]);
  return [...out].sort(([a], [b]) => a - b);
}

export async function buildAttribution(
  inputs: PipelineInputs,
  surplus: SurplusInput | undefined,
  readers: ReaderFactory,
  minTransferUsd: number,
  log: (line: string) => void = () => {}
): Promise<AttributionManifest> {
  if (surplus) verifySurplus(inputs, surplus);
  const {inventory, filtered, run} = inputs;
  const manifest: AttributionManifest = {
    filteredSha256: sha256(inputs.filteredText),
    runSha256: sha256(inputs.runText),
    minTransferUsd,
    ...(surplus
      ? {surplus: {sha256: sha256(surplus.text), sqlSha256: surplus.manifest.sqlSha256}}
      : {}),
    groups: [],
    deferred: [],
    failures: [],
  };

  for (const [chainId, holdings] of holdingsByChain(filtered)) {
    const chain = chainById(chainId);
    const range = run.chains.find((c) => c.chainId === chainId)!;
    const reader = readers(chain);
    try {
      if (!reader) throw new Error(`missing ${rpcEnv(chain)} or ALCHEMY_API_KEY`);
      assertChainId(await reader.chainId(), chain);
      for (const h of holdings) {
        const protocol = protocolAddresses(inventory, chainId, h.market);
        let group: Group;
        if (h.kind !== 'underlying-in-own-atoken') {
          log(
            `${chain.alias} (${chainId}): ${h.holderSymbol} holds ${h.amountFormatted} ${h.tokenSymbol}, scanning ${range.fromBlock}..${range.toBlock}...`
          );
          group = await scanGroup(chain, reader, h, range, protocol, minTransferUsd);
        } else if (!surplus) {
          manifest.deferred.push(h);
          continue;
        } else {
          const entry = surplus.manifest.holdings.find(
            (s) =>
              s.chainId === chainId &&
              isAddressEqual(s.holder, h.holder) &&
              isAddressEqual(s.token, h.token) &&
              s.fromBlock === range.fromBlock &&
              s.toBlock === range.toBlock
          );
          if (!entry)
            throw new Error(
              `surplus-transfers.json has no rows for ${h.holderSymbol}/${h.tokenSymbol} over ${range.fromBlock}..${range.toBlock}`
            );
          log(
            `${chain.alias} (${chainId}): ${h.holderSymbol} surplus ${h.amountFormatted} ${h.tokenSymbol}, verifying ${entry.rows.length} Dune row(s)...`
          );
          group = await verifySurplusGroup(
            chain,
            reader,
            h,
            entry,
            poolOf(inventory, chainId, h.market),
            protocol,
            surplus.manifest.sqlSha256,
            minTransferUsd
          );
        }
        manifest.groups.push(group);
        log(
          `${chain.alias} (${chainId}): ${group.transfers.length} transfer(s), ${group.wallets.length} wallet(s), ` +
            `${group.outflows.length} outflow(s), ${group.reconciliation.status}`
        );
      }
    } catch (error) {
      manifest.failures.push(chainFailure(chain, error, log));
    }
  }
  return manifest;
}

if (require.main === module)
  runCli(async () => {
    const args = process.argv.slice(2);
    const usage = 'usage: attribution.ts [--min-transfer-usd <amount>]';
    if (args.length !== 0 && (args.length !== 2 || args[0] !== '--min-transfer-usd'))
      throw new Error(usage);
    const minTransferUsd = args.length ? Number(args[1]) : 1;
    if (!Number.isInteger(minTransferUsd * 100) || minTransferUsd < 0) throw new Error(usage);
    const inputs = readInputs();
    const surplusText = fs.existsSync(SURPLUS_PATH)
      ? fs.readFileSync(SURPLUS_PATH, 'utf8')
      : undefined;
    const surplus: SurplusInput | undefined =
      surplusText === undefined
        ? undefined
        : {
            manifest: JSON.parse(surplusText),
            text: surplusText,
            sqlText: fs.readFileSync(SURPLUS_SQL_PATH, 'utf8'),
          };
    if (!surplus)
      console.log(
        `no ${path.relative(process.cwd(), SURPLUS_PATH)}: surplus holdings will be deferred (run phase4:surplus)`
      );
    const manifest = await buildAttribution(
      inputs,
      surplus,
      envReaderFactory(),
      minTransferUsd,
      console.log
    );
    const digest = writeCanonical(ATTRIBUTION_PATH, manifest);
    console.log(
      `attribution: ${manifest.groups.length} group(s), ${manifest.deferred.length} deferred, ` +
        `${manifest.failures.length} failed, written ${path.relative(process.cwd(), ATTRIBUTION_PATH)} (sha256 ${digest})`
    );
    if (manifest.failures.length) process.exitCode = 1;
  });
