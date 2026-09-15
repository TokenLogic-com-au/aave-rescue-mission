import {
  BlockNotFoundError,
  createPublicClient,
  getAddress,
  http,
  type AbiEvent,
  type Address,
  type Hash,
  type MulticallParameters,
} from 'viem';
import {ChainConfig, envReaders} from './chains';

/**
 * Everything the pipeline reads from a chain, behind one seam: headers, receipts, logs and
 * batched view calls. The viem adapter owns the client, timeouts, Multicall3 chunking, log range
 * splitting, missing-header retries and the receipt cache; tests use an in-memory adapter.
 */
export type Header = {number: bigint; timestamp: bigint};

export type Receipt = {
  from: Address;
  to: Address | null;
  block: bigint;
  logs: {address: Address; topics: readonly Hash[]; data: Hash; logIndex: number}[];
};

export type LogFilter = {
  address: Address;
  event: AbiEvent;
  args?: Record<string, unknown>;
  fromBlock: bigint;
  toBlock: bigint;
};

export type RawLog = {block: bigint; txHash: Hash; logIndex: number; args: Record<string, unknown>};

export type Call = {
  address: Address;
  abi: readonly unknown[];
  functionName: string;
  args?: readonly unknown[];
};

export type ChainReader = {
  chainId(): Promise<number>;
  latest(): Promise<Header>;
  header(block: bigint): Promise<Header>;
  receipt(hash: Hash): Promise<Receipt>;
  /** Canonical logs matching the filter, in [fromBlock, toBlock]. */
  logs(filter: LogFilter): Promise<RawLog[]>;
  /** View calls at `block` (latest when omitted); `undefined` where a call reverted. */
  read(calls: Call[], block?: bigint): Promise<(unknown | undefined)[]>;
};

export type ChainReaders = (chain: ChainConfig) => ChainReader | undefined;

/** Every value present, else an error naming the failed call. */
export function strict<T>(values: (unknown | undefined)[], what: string): T[] {
  const i = values.findIndex((v) => v === undefined);
  if (i !== -1) throw new Error(`${what} call ${i} failed`);
  return values as T[];
}

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

/** Multicall3 lives at the same address on every EVM chain in scope except zkSync. */
const MULTICALL3: Record<number, Address> = {324: '0xF9cda624FBC7e059355ce98a31693d299FACd963'};
const CHUNK = 300;

export function viemChainReader(url: string, chainId: number): ChainReader {
  const client = createPublicClient({transport: http(url, {batch: false, timeout: 60_000})});
  const receipts = new Map<Hash, Receipt>();
  const multicallAddress = MULTICALL3[chainId] ?? '0xcA11bde05977b3631167028862bE2a173976CA11';
  return {
    chainId: () => client.getChainId(),
    latest: async () => {
      const b = await client.getBlock({blockTag: 'latest'});
      return {number: b.number, timestamp: b.timestamp};
    },
    header: async (block) =>
      retryMissingBlock(async () => {
        const b = await client.getBlock({blockNumber: block});
        return {number: b.number, timestamp: b.timestamp};
      }),
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
    logs: ({address, event, args, fromBlock, toBlock}) =>
      adaptiveLogs(
        async (from, to) =>
          (
            await client.getLogs({
              address,
              event,
              args: args as never,
              fromBlock: from,
              toBlock: to,
            })
          )
            .filter((l) => !l.removed)
            .map((l) => ({
              block: l.blockNumber,
              txHash: l.transactionHash,
              logIndex: l.logIndex,
              args: l.args as Record<string, unknown>,
            })),
        fromBlock,
        toBlock
      ),
    read: async (calls, block) => {
      const out: (unknown | undefined)[] = [];
      for (let i = 0; i < calls.length; i += CHUNK) {
        const results = await client.multicall({
          contracts: calls.slice(i, i + CHUNK) as MulticallParameters['contracts'],
          ...(block === undefined ? {} : {blockNumber: block}),
          multicallAddress,
          allowFailure: true,
        });
        for (const r of results) out.push(r.status === 'success' ? r.result : undefined);
      }
      return out;
    },
  };
}

export const envChainReaders = (env: NodeJS.ProcessEnv = process.env): ChainReaders =>
  envReaders((url, chain) => viemChainReader(url, chain.chainId), env);
