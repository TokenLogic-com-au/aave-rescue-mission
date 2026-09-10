import fs from 'fs';
import path from 'path';
import {
  createPublicClient,
  erc20Abi,
  formatUnits,
  http,
  parseAbi,
  type Address,
  type MulticallParameters,
} from 'viem';
import {assertChainId, CHAINS, ChainConfig, envReaders, rpcEnv} from './chains';
import {compareAddresses, compareStrings, sha256, writeCanonical} from './canonical';
import {ChainFailure, chainFailure, runCli} from './cli';
import {readVerifiedInventory} from './inventory';
import {PINNED_AT} from './policy';
import {parseInstant, RUN_PATH, RunManifest} from './ranges';
import {usdValue} from './usd';
import {Inventory, Target} from '../common/types';

/**
 * Balance-first discovery at each chain's pinned block, for DAO-governed markets only.
 * An aToken legitimately holds only its own underlying, and only up to the Pool's virtual
 * balance; a Pool legitimately holds nothing. So for every market token (each reserve's
 * underlying and aToken) held by every aToken and by the Pool, anything found is stuck, except
 * the own-underlying case, where only the surplus over the virtual balance is.
 * Amounts are base-unit integers; formatted amounts and USD values (market AaveOracle at the
 * same block) are annotations for readers and for the eligibility policy.
 */
export type HoldingKind =
  | 'underlying-in-own-atoken'
  | 'atoken-in-itself'
  | 'market-token-in-atoken'
  | 'market-token-in-pool';

export type Holding = {
  chainId: number;
  chainAlias: string;
  market: string;
  kind: HoldingKind;
  holder: Address;
  holderSymbol: string;
  token: Address;
  tokenSymbol: string;
  decimals: number;
  /** Base units; negative only for a surplus below the virtual balance, which needs review. */
  amount: string;
  amountFormatted: string;
  /** For underlying-in-own-atoken: the Pool's virtual balance the surplus was measured against. */
  virtualBalance?: string;
  /** Oracle price in USD (formatted) and the resulting value; absent when the oracle had no price. */
  priceUsd?: string;
  valueUsd?: string;
  note?: string;
};

export type ChainBalances = {
  chainId: number;
  alias: string;
  block: number;
  holdings: Holding[];
};

export type BalancesManifest = {
  runSha256: string;
  inventorySha256: string;
  chains: ChainBalances[];
  failures: ChainFailure[];
};

export const BALANCES_PATH = path.resolve(__dirname, 'data/balances.json');

const POOL_ABI = parseAbi([
  'function getVirtualUnderlyingBalance(address asset) view returns (uint128)',
]);
const ORACLE_ABI = parseAbi([
  'function BASE_CURRENCY_UNIT() view returns (uint256)',
  'function getAssetPrice(address asset) view returns (uint256)',
]);

/** Multicall3 lives at the same address on every EVM chain in scope except zkSync. */
const MULTICALL3: Record<number, Address> = {324: '0xF9cda624FBC7e059355ce98a31693d299FACd963'};
const multicallAddress = (chainId: number): Address =>
  MULTICALL3[chainId] ?? '0xcA11bde05977b3631167028862bE2a173976CA11';

export type Pair = {token: Address; holder: Address};

/** State reads at a pinned block. Needs historical state on the node. */
export type BalanceReader = {
  chainId(): Promise<number>;
  balances(pairs: Pair[], block: bigint): Promise<bigint[]>;
  virtualBalances(pool: Address, assets: Address[], block: bigint): Promise<bigint[]>;
  /** Oracle base unit and one price per asset; a price is undefined when the oracle reverted for it. */
  prices(
    oracle: Address,
    assets: Address[],
    block: bigint
  ): Promise<{unit: bigint; prices: (bigint | undefined)[]}>;
};

const CHUNK = 300;

type Call = {address: Address; abi: readonly unknown[]; functionName: string; args: unknown[]};

function viemBalanceReader(url: string, chainId: number): BalanceReader {
  const client = createPublicClient({transport: http(url, {batch: false, timeout: 60_000})});
  const multicall = async (calls: Call[], blockNumber: bigint): Promise<(bigint | undefined)[]> => {
    const out: (bigint | undefined)[] = [];
    for (let i = 0; i < calls.length; i += CHUNK) {
      const results = await client.multicall({
        contracts: calls.slice(i, i + CHUNK) as MulticallParameters['contracts'],
        blockNumber,
        multicallAddress: multicallAddress(chainId),
        allowFailure: true,
      });
      for (const r of results) {
        out.push(r.status === 'success' ? BigInt(r.result as bigint) : undefined);
      }
    }
    return out;
  };
  const strict = (values: (bigint | undefined)[], what: string): bigint[] => {
    const i = values.findIndex((v) => v === undefined);
    if (i !== -1) throw new Error(`${what} call ${i} failed`);
    return values as bigint[];
  };
  return {
    chainId: () => client.getChainId(),
    balances: async (pairs, block) =>
      strict(
        await multicall(
          pairs.map((p) => ({
            address: p.token,
            abi: erc20Abi,
            functionName: 'balanceOf',
            args: [p.holder],
          })),
          block
        ),
        'balanceOf'
      ),
    virtualBalances: async (pool, assets, block) =>
      strict(
        await multicall(
          assets.map((a) => ({
            address: pool,
            abi: POOL_ABI,
            functionName: 'getVirtualUnderlyingBalance',
            args: [a],
          })),
          block
        ),
        'getVirtualUnderlyingBalance'
      ),
    prices: async (oracle, assets, block) => {
      const [unit, ...prices] = await multicall(
        [
          {address: oracle, abi: ORACLE_ABI, functionName: 'BASE_CURRENCY_UNIT', args: []},
          ...assets.map((a) => ({
            address: oracle,
            abi: ORACLE_ABI,
            functionName: 'getAssetPrice',
            args: [a],
          })),
        ],
        block
      );
      if (unit === undefined) throw new Error('oracle BASE_CURRENCY_UNIT failed');
      return {unit, prices};
    },
  };
}

export type ReaderFactory = (chain: ChainConfig) => BalanceReader | undefined;

export const envReaderFactory = (env: NodeJS.ProcessEnv = process.env): ReaderFactory =>
  envReaders((url, chain) => viemBalanceReader(url, chain.chainId), env);

function compareHoldings(a: Holding, b: Holding): number {
  return (
    compareStrings(a.market, b.market) ||
    compareAddresses(a.holder, b.holder) ||
    compareAddresses(a.token, b.token)
  );
}

type MarketToken = {address: Address; symbol: string; decimals: number; underlying: Address};

/** Holdings for one market at `block`. */
async function marketHoldings(
  chain: ChainConfig,
  reader: BalanceReader,
  market: string,
  pool: Address,
  oracle: Address,
  aTokens: Target[],
  block: bigint
): Promise<Holding[]> {
  // Every market token: each reserve's underlying and aToken, both priced by the underlying.
  const tokens: MarketToken[] = aTokens.flatMap((t) => [
    {address: t.underlying!, symbol: t.symbol!, decimals: t.decimals!, underlying: t.underlying!},
    {address: t.target, symbol: `a${t.symbol!}`, decimals: t.decimals!, underlying: t.underlying!},
  ]);
  const holders: {address: Address; symbol: string; own?: Address}[] = [
    ...aTokens.map((t) => ({address: t.target, symbol: `a${t.symbol!}`, own: t.underlying!})),
    {address: pool, symbol: 'Pool'},
  ];
  const underlyings = aTokens.map((t) => t.underlying!);
  const pairs: Pair[] = holders.flatMap((h) =>
    tokens.map((t) => ({token: t.address, holder: h.address}))
  );
  const [balances, virtuals, {unit, prices}] = await Promise.all([
    reader.balances(pairs, block),
    reader.virtualBalances(pool, underlyings, block),
    reader.prices(oracle, underlyings, block),
  ]);
  const virtualOf = new Map(underlyings.map((u, i) => [u.toLowerCase(), virtuals[i]]));
  const priceOf = new Map(underlyings.map((u, i) => [u.toLowerCase(), prices[i]]));
  const priceDecimals = unit.toString().length - 1;

  const found: Holding[] = [];
  pairs.forEach((_, i) => {
    const token = tokens[i % tokens.length];
    const holder = holders[Math.floor(i / tokens.length)];
    let amount = balances[i];
    let kind: HoldingKind;
    let virtualBalance: string | undefined;
    let note: string | undefined;
    if (holder.own && token.address === holder.own) {
      const virtual = virtualOf.get(token.address.toLowerCase())!;
      amount -= virtual;
      kind = 'underlying-in-own-atoken';
      virtualBalance = virtual.toString();
      if (virtual === 0n && amount !== 0n) {
        note = 'virtual balance is zero: reserve may not use virtual accounting; review';
      } else if (amount < 0n) {
        note = 'balance below virtual balance; review';
      }
    } else if (!holder.own) {
      kind = 'market-token-in-pool';
    } else if (token.address === holder.address) {
      kind = 'atoken-in-itself';
    } else {
      kind = 'market-token-in-atoken';
    }
    if (amount === 0n) return;
    const price = priceOf.get(token.underlying.toLowerCase());
    found.push({
      chainId: chain.chainId,
      chainAlias: chain.alias,
      market,
      kind,
      holder: holder.address,
      holderSymbol: holder.symbol,
      token: token.address,
      tokenSymbol: token.symbol,
      decimals: token.decimals,
      amount: amount.toString(),
      amountFormatted: formatUnits(amount, token.decimals),
      ...(virtualBalance !== undefined ? {virtualBalance} : {}),
      ...(price !== undefined
        ? {
            priceUsd: formatUnits(price, priceDecimals),
            valueUsd: usdValue(amount, token.decimals, price, unit),
          }
        : {}),
      ...(note ? {note} : {}),
    });
  });
  return found;
}

/** Holdings for one chain at `block`, for its DAO-governed markets only. */
export async function chainHoldings(
  chain: ChainConfig,
  reader: BalanceReader,
  targets: Target[],
  block: bigint
): Promise<Holding[]> {
  const rows = targets.filter((t) => t.chainId === chain.chainId && t.governedByDao);
  const markets = [...new Set(rows.map((t) => t.market))].sort(compareStrings);
  const all: Holding[] = [];
  for (const market of markets) {
    const pool = rows.find((t) => t.market === market && t.targetType === 'pool')!;
    const aTokens = rows.filter((t) => t.market === market && t.targetType === 'aToken');
    all.push(
      ...(await marketHoldings(chain, reader, market, pool.target, pool.oracle, aTokens, block))
    );
  }
  return all.sort(compareHoldings);
}

export async function buildBalances(
  inventory: Inventory,
  inventoryText: string,
  run: RunManifest,
  runText: string,
  readers: ReaderFactory,
  log: (line: string) => void = () => {}
): Promise<BalancesManifest> {
  if (run.failures.length) throw new Error('run.json is not final: it has failures');
  if (run.inventorySha256 !== sha256(inventoryText))
    throw new Error('run.json was pinned against a different inventory');
  if (run.pinnedAt !== parseInstant(PINNED_AT).toISOString())
    throw new Error('run.json is not pinned at PINNED_AT');
  const manifest: BalancesManifest = {
    runSha256: sha256(runText),
    inventorySha256: run.inventorySha256,
    chains: [],
    failures: [],
  };
  for (const chain of CHAINS) {
    const range = run.chains.find((c) => c.chainId === chain.chainId);
    const reader = readers(chain);
    try {
      if (!range) throw new Error('not pinned in run.json');
      if (!reader) throw new Error(`missing ${rpcEnv(chain)} or ALCHEMY_API_KEY`);
      assertChainId(await reader.chainId(), chain);
      log(`${chain.alias} (${chain.chainId}): reading balances at block ${range.toBlock}...`);
      const holdings = await chainHoldings(chain, reader, inventory.targets, BigInt(range.toBlock));
      manifest.chains.push({
        chainId: chain.chainId,
        alias: chain.alias,
        block: range.toBlock,
        holdings,
      });
      log(`${chain.alias} (${chain.chainId}): ${holdings.length} holding(s)`);
    } catch (error) {
      manifest.failures.push(chainFailure(chain, error, log));
    }
  }
  manifest.chains.sort((a, b) => a.chainId - b.chainId);
  manifest.failures.sort((a, b) => a.chainId - b.chainId);
  return manifest;
}

if (require.main === module)
  runCli(async () => {
    const {inventory, text: inventoryText} = readVerifiedInventory();
    const runText = fs.readFileSync(RUN_PATH, 'utf8');
    const manifest = await buildBalances(
      inventory,
      inventoryText,
      JSON.parse(runText),
      runText,
      envReaderFactory(),
      console.log
    );
    const digest = writeCanonical(BALANCES_PATH, manifest);
    const total = manifest.chains.reduce((n, c) => n + c.holdings.length, 0);
    console.log(
      `balances: ${manifest.chains.length} chains, ${total} holdings, ${manifest.failures.length} failed, ` +
        `written ${path.relative(process.cwd(), BALANCES_PATH)} (sha256 ${digest})`
    );
    if (manifest.failures.length) process.exitCode = 1;
  });
