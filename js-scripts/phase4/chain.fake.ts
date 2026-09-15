import type {Address, Hash} from 'viem';
import type {Call, ChainReader, RawLog, Receipt} from './chain';

/** In-memory adapter for the ChainReader seam: fixture headers, receipts, logs and view results. */
export type FakeChain = {
  chainId?: number;
  latest?: bigint;
  /** Timestamp of a block; default 1000 + 12 * block. */
  timestamp?: (block: bigint) => bigint;
  receipts?: Record<string, Receipt>;
  logs?: (RawLog & {address: Address})[];
  /** Result of one view call; return undefined for a revert. */
  read?: (call: Call, block?: bigint) => unknown | undefined;
};

const same = (a: unknown, b: unknown) => String(a).toLowerCase() === String(b).toLowerCase();

export function fakeChain(fake: FakeChain = {}): ChainReader {
  const timestamp = fake.timestamp ?? ((n: bigint) => 1000n + 12n * n);
  const latest = fake.latest ?? 1000n;
  return {
    chainId: async () => fake.chainId ?? 8453,
    latest: async () => ({number: latest, timestamp: timestamp(latest)}),
    header: async (block) => ({number: block, timestamp: timestamp(block)}),
    receipt: async (hash: Hash) => {
      const r = fake.receipts?.[hash];
      if (!r) throw new Error(`no receipt for ${hash}`);
      return r;
    },
    logs: async ({address, args, fromBlock, toBlock}) =>
      (fake.logs ?? [])
        .filter(
          (l) =>
            same(l.address, address) &&
            l.block >= fromBlock &&
            l.block <= toBlock &&
            Object.entries(args ?? {}).every(([k, v]) => same(l.args[k], v))
        )
        .map(({address: _a, ...l}) => l),
    read: async (calls, block) => calls.map((c) => fake.read?.(c, block)),
  };
}
