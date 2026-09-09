import fs from 'fs';
import path from 'path';
import {
  BlockNotFoundError,
  createPublicClient,
  http,
  parseAbi,
  toEventSelector,
  type Address,
  type Hash,
} from 'viem';
import {
  assertChainId,
  CHAINS,
  ChainConfig,
  envReaders,
  EXCLUSIONS,
  PHASE_2_3_EXECUTION,
  Phase23Execution,
  rpcEnv,
} from './chains';
import {compareStrings, sha256, writeCanonical} from './canonical';
import {ChainFailure, chainFailure, runCli} from './cli';
import {PINNED_AT} from './policy';
import {readVerifiedInventory} from './inventory';
import {
  checkPermissionsBookPin,
  DeploymentBlock,
  loadDeploymentBlocks,
  PERMISSIONS_BOOK_PIN,
} from './permissionsBook';
import {Inventory, Target} from '../common/types';

/** `DistributionAdded(address indexed token, bytes32 indexed merkleRoot, uint256 indexed distributionId)` */
const DISTRIBUTION_ADDED = toEventSelector(
  'DistributionAdded(address indexed token, bytes32 indexed merkleRoot, uint256 indexed distributionId)'
);

const ACL_MANAGER_ABI = parseAbi(['function isPoolAdmin(address admin) view returns (bool)']);

/** Minimal chain reader so the range logic is testable without a network. Headers, receipts and one view call. */
export type BlockReader = {
  chainId(): Promise<number>;
  latestBlock(): Promise<{number: bigint; timestamp: bigint}>;
  blockTimestamp(blockNumber: bigint): Promise<bigint>;
  /** Block a transaction was mined in and whether it emitted DistributionAdded from `distributor`. */
  transactionBlock(
    hash: Hash,
    distributor: Address
  ): Promise<{block: bigint; distributionAdded: boolean}>;
  /** ACLManager.isPoolAdmin(account) at the latest block; the gate on rescueTokens. */
  isPoolAdmin(aclManager: Address, account: Address): Promise<boolean>;
};

export type MarketAuthority = {
  market: string;
  aclManager: Address;
  executor: Address;
  /** Confirmed on-chain: the executor holds POOL_ADMIN on this market's ACL manager. */
  poolAdmin: true;
};

export type ChainRange = {
  chainId: number;
  alias: string;
  fromBlock: number;
  fromBlockSource: 'phase-2-3-execution' | 'permissions-book';
  toBlock: number;
  toBlockTimestamp: number;
  /** DAO-governed markets on the chain whose pool-admin role was verified for the executor. */
  markets: MarketAuthority[];
};

export type RunManifest = {
  /** Target instant; toBlock on each chain is the last block at or before it. */
  pinnedAt: string;
  inventorySha256: string;
  permissionsBook: {repository: string; commit: string};
  chains: ChainRange[];
  failures: ChainFailure[];
  exclusions: {scope: string; reason: string}[];
};

export const RUN_PATH = path.resolve(__dirname, 'data/run.json');

/** Some nodes answer null for a single historical header; viem reports that as BlockNotFoundError and does not retry it. */
async function retryMissingBlock<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (error) {
      if (!(error instanceof BlockNotFoundError) || i === attempts) throw error;
      await new Promise((r) => setTimeout(r, 500 * i));
    }
  }
}

function viemReader(rpcUrl: string): BlockReader {
  const client = createPublicClient({transport: http(rpcUrl, {batch: false, timeout: 60_000})});
  return {
    chainId: () => client.getChainId(),
    latestBlock: async () => {
      const b = await client.getBlock({blockTag: 'latest'});
      return {number: b.number, timestamp: b.timestamp};
    },
    blockTimestamp: async (blockNumber) =>
      retryMissingBlock(async () => (await client.getBlock({blockNumber})).timestamp),
    transactionBlock: async (hash, distributor) => {
      const receipt = await client.getTransactionReceipt({hash});
      const distributionAdded = receipt.logs.some(
        (l) =>
          l.address.toLowerCase() === distributor.toLowerCase() &&
          l.topics[0]?.toLowerCase() === DISTRIBUTION_ADDED
      );
      return {block: receipt.blockNumber, distributionAdded};
    },
    isPoolAdmin: (aclManager, account) =>
      client.readContract({
        address: aclManager,
        abi: ACL_MANAGER_ABI,
        functionName: 'isPoolAdmin',
        args: [account],
      }),
  };
}

/**
 * Last block whose timestamp is <= target. The target must be strictly in the past on the chain,
 * otherwise the result would move between runs.
 */
export async function blockAtOrBefore(reader: BlockReader, target: bigint): Promise<bigint> {
  const latest = await reader.latestBlock();
  if (latest.timestamp <= target) {
    throw new Error(
      `instant ${target} is not in the past (latest block ${latest.number} at ${latest.timestamp})`
    );
  }
  if ((await reader.blockTimestamp(0n)) > target) {
    throw new Error(`no block at or before timestamp ${target}`);
  }
  let lo = 0n;
  let hi = latest.number;
  while (hi - lo > 1n) {
    const mid = (lo + hi) / 2n;
    if ((await reader.blockTimestamp(mid)) <= target) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** Accepted only if the receipt is at the recorded block and emitted DistributionAdded from the distributor. */
async function verifyExecution(reader: BlockReader, executed: Phase23Execution): Promise<void> {
  const {block, distributionAdded} = await reader.transactionBlock(
    executed.tx,
    executed.distributor
  );
  if (block !== BigInt(executed.block)) {
    throw new Error(`${executed.tx} mined at block ${block}, expected ${executed.block}`);
  }
  if (!distributionAdded) {
    throw new Error(`${executed.tx} did not emit DistributionAdded from ${executed.distributor}`);
  }
}

/** Start block and its source for a chain, re-derived from evidence every run. */
export async function resolveStart(
  chain: ChainConfig,
  reader: BlockReader,
  deployment: DeploymentBlock | undefined
): Promise<Pick<ChainRange, 'fromBlock' | 'fromBlockSource'>> {
  const executed = PHASE_2_3_EXECUTION[chain.chainId];
  if (executed) {
    await verifyExecution(reader, executed);
    return {fromBlock: executed.block, fromBlockSource: 'phase-2-3-execution'};
  }
  if (deployment) return {fromBlock: deployment.block, fromBlockSource: 'permissions-book'};
  throw new Error('no deployment block in the permissions book');
}

export async function resolveChainRange(
  chain: ChainConfig,
  reader: BlockReader,
  deployment: DeploymentBlock | undefined,
  pinnedAt: bigint
): Promise<Omit<ChainRange, 'markets'>> {
  const toBlock = await blockAtOrBefore(reader, pinnedAt);
  const toBlockTimestamp = await reader.blockTimestamp(toBlock);
  const from = await resolveStart(chain, reader, deployment);
  if (BigInt(from.fromBlock) > toBlock)
    throw new Error(`start block ${from.fromBlock} is after the pinned block ${toBlock}`);
  return {
    chainId: chain.chainId,
    alias: chain.alias,
    ...from,
    toBlock: Number(toBlock),
    toBlockTimestamp: Number(toBlockTimestamp),
  };
}

/**
 * Checks a range against the chain: the end block's timestamp is the recorded one, at or before
 * the instant, with the next block after it; and the start block matches the evidence it claims.
 * Applies to fresh and reused ranges alike.
 */
export async function verifyRange(
  range: Omit<ChainRange, 'markets'>,
  chain: ChainConfig,
  reader: BlockReader,
  deployment: DeploymentBlock | undefined,
  target: bigint
): Promise<void> {
  const toBlock = BigInt(range.toBlock);
  const ts = await reader.blockTimestamp(toBlock);
  if (ts !== BigInt(range.toBlockTimestamp)) {
    throw new Error(
      `toBlock ${range.toBlock}: chain timestamp ${ts} != recorded ${range.toBlockTimestamp}`
    );
  }
  if (ts > target) throw new Error(`toBlock ${range.toBlock} timestamp ${ts} is after ${target}`);
  const next = await reader.blockTimestamp(toBlock + 1n);
  if (next <= target) {
    throw new Error(`toBlock ${range.toBlock} is not the last block before ${target}`);
  }
  const start = await resolveStart(chain, reader, deployment);
  if (start.fromBlock !== range.fromBlock || start.fromBlockSource !== range.fromBlockSource) {
    throw new Error(
      `fromBlock ${range.fromBlock} (${range.fromBlockSource}) != evidence ${start.fromBlock} (${start.fromBlockSource})`
    );
  }
  if (range.fromBlock > range.toBlock) {
    throw new Error(`fromBlock ${range.fromBlock} > toBlock ${range.toBlock}`);
  }
}

/** Every DAO-governed market on the chain must have the executor as POOL_ADMIN on-chain. */
export async function verifyAuthorities(
  chain: ChainConfig,
  reader: BlockReader,
  targets: Target[]
): Promise<MarketAuthority[]> {
  const markets = new Map<string, Target>();
  for (const t of targets) {
    if (t.chainId === chain.chainId && t.governedByDao && !markets.has(t.market)) {
      markets.set(t.market, t);
    }
  }
  const authorities: MarketAuthority[] = [];
  for (const [market, t] of [...markets].sort(([a], [b]) => compareStrings(a, b))) {
    if (!(await reader.isPoolAdmin(t.aclManager, t.executor))) {
      throw new Error(`${market}: executor ${t.executor} is not POOL_ADMIN on ${t.aclManager}`);
    }
    authorities.push({market, aclManager: t.aclManager, executor: t.executor, poolAdmin: true});
  }
  return authorities;
}

export type ReaderFactory = (chain: ChainConfig) => BlockReader | undefined;

export const envReaderFactory = (env: NodeJS.ProcessEnv = process.env): ReaderFactory =>
  envReaders(viemReader, env);

/**
 * Chains from a previous manifest that can be reused: same instant, inventory and permissions
 * book, since every range is a pure function of those. They are still verified before being written.
 */
export function reusableChains(
  previous: RunManifest | undefined,
  pinnedAt: Date,
  inventorySha256: string
): Map<number, ChainRange> {
  if (
    !previous ||
    previous.pinnedAt !== pinnedAt.toISOString() ||
    previous.inventorySha256 !== inventorySha256 ||
    previous.permissionsBook?.commit !== PERMISSIONS_BOOK_PIN.commit
  ) {
    return new Map();
  }
  return new Map(previous.chains.map((c) => [c.chainId, c]));
}

/** Resolves and verifies ranges and authorities for every chain; anything that fails lands in `failures`. */
export async function buildRun(
  inventory: Inventory,
  inventoryText: string,
  pinnedAt: Date,
  readers: ReaderFactory,
  deployments: Map<number, DeploymentBlock>,
  log: (line: string) => void = () => {},
  previous?: RunManifest
): Promise<RunManifest> {
  const inventorySha256 = sha256(inventoryText);
  const reusable = reusableChains(previous, pinnedAt, inventorySha256);
  const manifest: RunManifest = {
    pinnedAt: pinnedAt.toISOString(),
    inventorySha256,
    permissionsBook: {...PERMISSIONS_BOOK_PIN},
    chains: [],
    failures: [],
    exclusions: [...EXCLUSIONS],
  };
  const target = BigInt(Math.floor(pinnedAt.getTime() / 1000));
  for (const chain of CHAINS) {
    const reader = readers(chain);
    const deployment = deployments.get(chain.chainId);
    const reused = reusable.get(chain.chainId);
    try {
      if (!reader) throw new Error(`missing ${rpcEnv(chain)} or ALCHEMY_API_KEY`);
      assertChainId(await reader.chainId(), chain);
      let range: Omit<ChainRange, 'markets'>;
      if (reused) {
        // A reused pin is a claim; a fresh one is built from the evidence the check would reread.
        log(`${chain.alias} (${chain.chainId}): reusing previous pin, verifying...`);
        await verifyRange(reused, chain, reader, deployment, target);
        range = reused;
      } else {
        log(`${chain.alias} (${chain.chainId}): pinning...`);
        range = await resolveChainRange(chain, reader, deployment, target);
      }
      const markets = await verifyAuthorities(chain, reader, inventory.targets);
      manifest.chains.push({...range, markets});
      log(
        `${chain.alias} (${chain.chainId}): from ${range.fromBlock} (${range.fromBlockSource}) ` +
          `to ${range.toBlock} @ ${new Date(range.toBlockTimestamp * 1000).toISOString()}; ` +
          `pool admin verified on ${markets.length} market(s)`
      );
    } catch (error) {
      manifest.failures.push(chainFailure(chain, error, log));
    }
  }
  manifest.chains.sort((a, b) => a.chainId - b.chainId);
  manifest.failures.sort((a, b) => a.chainId - b.chainId);
  return manifest;
}

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

/** Accepts only an explicit UTC instant, so the pin cannot shift with the host time zone. */
export function parseInstant(text: string): Date {
  if (!ISO_UTC.test(text)) {
    throw new Error(`instant must be ISO-8601 UTC, e.g. 2026-09-01T00:00:00Z: ${text}`);
  }
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) throw new Error(`invalid instant: ${text}`);
  return date;
}

function readPrevious(): RunManifest | undefined {
  return fs.existsSync(RUN_PATH)
    ? (JSON.parse(fs.readFileSync(RUN_PATH, 'utf8')) as RunManifest)
    : undefined;
}

if (require.main === module)
  runCli(async () => {
    const args = process.argv.slice(2);
    if (args.some((a) => a !== '--refresh')) throw new Error('usage: ranges.ts [--refresh]');
    const refresh = args.includes('--refresh');
    checkPermissionsBookPin();
    const {inventory, text: inventoryText} = readVerifiedInventory();
    const pinnedAt = parseInstant(PINNED_AT);
    console.log(`pinning ${CHAINS.length} chains at ${pinnedAt.toISOString()}`);
    const manifest = await buildRun(
      inventory,
      inventoryText,
      pinnedAt,
      envReaderFactory(),
      loadDeploymentBlocks(),
      console.log,
      refresh ? undefined : readPrevious()
    );
    const digest = writeCanonical(RUN_PATH, manifest);
    console.log(
      `run: ${manifest.chains.length} chains pinned, ${manifest.failures.length} failed, ` +
        `written ${path.relative(process.cwd(), RUN_PATH)} (sha256 ${digest})`
    );
    if (manifest.failures.length) process.exitCode = 1;
  });
