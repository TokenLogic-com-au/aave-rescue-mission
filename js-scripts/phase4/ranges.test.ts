import {describe, expect, it} from 'vitest';
import {canonicalJson} from './canonical';
import {redact} from './cli';
import {chainById, PHASE_2_3_EXECUTION, rpcUrl} from './chains';
import {DeploymentBlock, PERMISSIONS_BOOK_PIN} from './permissionsBook';
import {Inventory, Target} from '../common/types';
import {
  BlockReader,
  blockAtOrBefore,
  buildRun,
  ChainRange,
  parseInstant,
  resolveChainRange,
  reusableChains,
  verifyAuthorities,
  verifyRange,
} from './ranges';

type Tx = {block: bigint; distributionAdded: boolean};
type Fake = {
  chainId?: number;
  txs?: Record<string, Tx>;
  /** aclManager -> accounts holding POOL_ADMIN; undefined means everyone is admin. */
  admins?: Record<string, string[]>;
};

/** Fake chain: block n has timestamp 1000 + 12n; recorded transactions confirm unless overridden. */
function fakeReader(latest: bigint, fake: Fake = {}): BlockReader {
  const ts = (n: bigint) => 1000n + 12n * n;
  return {
    chainId: async () => fake.chainId ?? 8453,
    latestBlock: async () => ({number: latest, timestamp: ts(latest)}),
    blockTimestamp: async (n) => ts(n),
    transactionBlock: async (hash) => {
      if (fake.txs && hash in fake.txs) return fake.txs[hash];
      const known = Object.values(PHASE_2_3_EXECUTION).find((e) => e.tx === hash);
      if (!known) throw new Error(`unknown transaction ${hash}`);
      return {block: BigInt(known.block), distributionAdded: true};
    },
    isPoolAdmin: async (aclManager, account) =>
      fake.admins === undefined ||
      (fake.admins[aclManager.toLowerCase()] ?? []).some(
        (a) => a.toLowerCase() === account.toLowerCase()
      ),
  };
}

const POOL = '0x0000000000000000000000000000000000000001' as const;
const ACL = '0x00000000000000000000000000000000000000ac' as const;
const EXECUTOR = '0x9390B1735def18560c509E2d0bc090E9d6BA257a' as const;
const BASE = chainById(8453);
const BASE_DEPLOYMENT: DeploymentBlock = {block: 120, market: 'V3'};

const baseTarget = (over: Partial<Target> = {}): Target => ({
  chainId: 8453,
  chainAlias: 'base',
  market: 'AaveV3Base',
  executor: EXECUTOR,
  aclAdmin: EXECUTOR,
  aclManager: ACL,
  oracle: ACL,
  governedByDao: true,
  targetType: 'pool',
  target: POOL,
  source: 'AaveV3Base.POOL',
  ...over,
});

describe('blockAtOrBefore', () => {
  it('finds the last block at or before a timestamp', async () => {
    const reader = fakeReader(1000n);
    expect(await blockAtOrBefore(reader, 1000n + 12n * 500n)).toBe(500n);
    expect(await blockAtOrBefore(reader, 1000n + 12n * 500n + 5n)).toBe(500n);
    expect(await blockAtOrBefore(reader, 1000n + 12n * 500n - 1n)).toBe(499n);
  });

  it('refuses an instant that is not in the past, so the pin cannot drift', async () => {
    const reader = fakeReader(77n);
    await expect(blockAtOrBefore(reader, 1000n + 12n * 77n)).rejects.toThrow('not in the past');
    await expect(blockAtOrBefore(reader, 10n ** 12n)).rejects.toThrow('not in the past');
  });

  it('throws when the chain did not exist yet', async () => {
    await expect(blockAtOrBefore(fakeReader(77n), 999n)).rejects.toThrow('no block');
  });
});

describe('resolveChainRange', () => {
  const pinnedAt = 1000n + 12n * 900n;

  it('starts at the Phase 2&3 execution block on rescued chains', async () => {
    const later = 1000n + 12n * 18195900n;
    const range = await resolveChainRange(chainById(1), fakeReader(18196000n), undefined, later);
    expect(range.fromBlock).toBe(18195705);
    expect(range.fromBlockSource).toBe('phase-2-3-execution');
    expect(range.toBlock).toBe(18195900);
    expect(range.toBlockTimestamp).toBe(Number(later));
  });

  it('rejects a window whose start is after the pinned block', async () => {
    await expect(
      resolveChainRange(chainById(1), fakeReader(1000n), undefined, pinnedAt)
    ).rejects.toThrow('start block 18195705 is after the pinned block 900');
  });

  it('rejects a recorded transaction the chain does not confirm', async () => {
    const tx = PHASE_2_3_EXECUTION[1].tx;
    const wrongBlock = fakeReader(1000n, {txs: {[tx]: {block: 1n, distributionAdded: true}}});
    await expect(resolveChainRange(chainById(1), wrongBlock, undefined, pinnedAt)).rejects.toThrow(
      'expected 18195705'
    );
    const noEvent = fakeReader(1000n, {txs: {[tx]: {block: 18195705n, distributionAdded: false}}});
    await expect(resolveChainRange(chainById(1), noEvent, undefined, pinnedAt)).rejects.toThrow(
      'did not emit DistributionAdded'
    );
  });

  it('starts at the permissions-book deployment block on other chains', async () => {
    const range = await resolveChainRange(BASE, fakeReader(1000n), BASE_DEPLOYMENT, pinnedAt);
    expect(range.fromBlock).toBe(120);
    expect(range.fromBlockSource).toBe('permissions-book');
  });

  it('fails when the permissions book has no block for the chain', async () => {
    await expect(resolveChainRange(BASE, fakeReader(1000n), undefined, pinnedAt)).rejects.toThrow(
      'no deployment block'
    );
  });
});

describe('verifyRange', () => {
  const target = 1000n + 12n * 500n + 5n;
  const good: Omit<ChainRange, 'markets'> = {
    chainId: 8453,
    alias: 'base',
    fromBlock: 120,
    fromBlockSource: 'permissions-book',
    toBlock: 500,
    toBlockTimestamp: 1000 + 12 * 500,
  };
  const reader = fakeReader(1000n);
  const check = (range: Omit<ChainRange, 'markets'>, deployment = BASE_DEPLOYMENT) =>
    verifyRange(range, BASE, reader, deployment, target);

  it('accepts a range whose end block is the last one before the instant and whose start matches evidence', async () => {
    await expect(check(good)).resolves.toBeUndefined();
  });

  it('rejects wrong timestamps, late blocks, early blocks, wrong starts and inverted ranges', async () => {
    await expect(check({...good, toBlockTimestamp: 1})).rejects.toThrow('!= recorded');
    await expect(check({...good, toBlock: 501, toBlockTimestamp: 1000 + 12 * 501})).rejects.toThrow(
      'after'
    );
    await expect(check({...good, toBlock: 499, toBlockTimestamp: 1000 + 12 * 499})).rejects.toThrow(
      'not the last'
    );
    await expect(check({...good, fromBlock: 121})).rejects.toThrow('!= evidence');
    await expect(check({...good, fromBlockSource: 'phase-2-3-execution'})).rejects.toThrow(
      '!= evidence'
    );
    await expect(check(good, {block: 600, market: 'V3'})).rejects.toThrow('!= evidence');
  });
});

describe('verifyAuthorities', () => {
  it('confirms POOL_ADMIN for every DAO-governed market and skips the others', async () => {
    const targets = [
      baseTarget(),
      baseTarget({
        targetType: 'aToken',
        target: '0x0000000000000000000000000000000000000002',
        symbol: 'X',
        decimals: 18,
        underlying: POOL,
      }),
      baseTarget({
        market: 'AaveV3BaseOther',
        aclAdmin: POOL,
        governedByDao: false,
        aclManager: POOL,
      }),
    ];
    const reader = fakeReader(1000n, {admins: {[ACL.toLowerCase()]: [EXECUTOR]}});
    const authorities = await verifyAuthorities(BASE, reader, targets);
    expect(authorities).toEqual([
      {market: 'AaveV3Base', aclManager: ACL, executor: EXECUTOR, poolAdmin: true},
    ]);
  });

  it('fails when the executor is not POOL_ADMIN on a DAO-governed market', async () => {
    const reader = fakeReader(1000n, {admins: {[ACL.toLowerCase()]: []}});
    await expect(verifyAuthorities(BASE, reader, [baseTarget()])).rejects.toThrow('not POOL_ADMIN');
  });
});

describe('redact', () => {
  it('removes RPC URLs and client noise from failure reasons', () => {
    const raw =
      'Timeout.\n\nURL: https://x.g.alchemy.com/v2/secretkey\nRequest body: {}\n\nDetails: timed out\nVersion: viem@2.56.3';
    const out = redact(raw);
    expect(out).not.toContain('secretkey');
    expect(out).toBe('Timeout. URL: <rpc> Request body: {} Details: timed out');
  });
});

describe('rpcUrl', () => {
  it('prefers RPC_<ALIAS>, falls back to Alchemy, else undefined', () => {
    expect(rpcUrl(BASE, {RPC_BASE: 'http://x', ALCHEMY_API_KEY: 'k'})).toBe('http://x');
    expect(rpcUrl(BASE, {ALCHEMY_API_KEY: 'k'})).toBe('https://base-mainnet.g.alchemy.com/v2/k');
    expect(rpcUrl(BASE, {})).toBeUndefined();
  });
});

describe('parseInstant', () => {
  it('accepts only explicit UTC instants', () => {
    expect(parseInstant('2026-09-01T00:00:00Z').toISOString()).toBe('2026-09-01T00:00:00.000Z');
    expect(() => parseInstant('2026-09-01')).toThrow('ISO-8601 UTC');
    expect(() => parseInstant('2026-09-01T00:00:00')).toThrow('ISO-8601 UTC');
    expect(() => parseInstant('2026-09-01T00:00:00+02:00')).toThrow('ISO-8601 UTC');
  });
});

describe('buildRun', () => {
  const inventory: Inventory = {
    addressBook: {repository: 'x', commit: 'y', tag: 'z'},
    targets: [baseTarget()],
  };
  const text = canonicalJson(inventory);
  const pinnedAt = new Date((1000 + 12 * 900) * 1000);
  const readers = (chain: {chainId: number}) =>
    chain.chainId === 8453 ? fakeReader(1000n) : undefined;
  const deployments = new Map([[8453, BASE_DEPLOYMENT]]);

  it('records chains without RPC as explicit failures and never drops them', async () => {
    const run = await buildRun(inventory, text, pinnedAt, readers, deployments);
    expect(run.chains.map((c) => c.chainId)).toEqual([8453]);
    expect(run.chains[0].markets).toEqual([
      {market: 'AaveV3Base', aclManager: ACL, executor: EXECUTOR, poolAdmin: true},
    ]);
    expect(run.failures).toHaveLength(20);
    expect(run.failures.every((f) => f.reason.startsWith('missing RPC_'))).toBe(true);
    expect(run.permissionsBook).toEqual(PERMISSIONS_BOOK_PIN);
  });

  it('fails a chain whose RPC serves a different chain id', async () => {
    const wrongChain = (chain: {chainId: number}) =>
      chain.chainId === 8453 ? fakeReader(1000n, {chainId: 1}) : undefined;
    const run = await buildRun(inventory, text, pinnedAt, wrongChain, deployments);
    expect(run.chains).toHaveLength(0);
    expect(run.failures.find((f) => f.chainId === 8453)?.reason).toContain('serves chain 1');
  });

  it('fails a chain where the executor is not pool admin', async () => {
    const noAdmin = (chain: {chainId: number}) =>
      chain.chainId === 8453 ? fakeReader(1000n, {admins: {}}) : undefined;
    const run = await buildRun(inventory, text, pinnedAt, noAdmin, deployments);
    expect(run.chains).toHaveLength(0);
    expect(run.failures.find((f) => f.chainId === 8453)?.reason).toContain('not POOL_ADMIN');
  });

  it('lists the out-of-scope items, including the whitelabel market', async () => {
    const run = await buildRun(inventory, text, pinnedAt, readers, deployments);
    expect(run.exclusions.map((e) => e.scope)).toContain('Aave V4 hubs');
    expect(run.exclusions.some((e) => e.scope.startsWith('AaveV3InkWhitelabel'))).toBe(true);
  });

  it('reuses chains from a previous run but still verifies them', async () => {
    const first = await buildRun(inventory, text, pinnedAt, readers, deployments);
    let headerReads = 0;
    const counting = (chain: {chainId: number}) => {
      const r = readers(chain);
      if (!r) return undefined;
      return {
        ...r,
        blockTimestamp: async (n: bigint) => {
          headerReads++;
          return r.blockTimestamp(n);
        },
      };
    };
    const second = await buildRun(
      inventory,
      text,
      pinnedAt,
      counting,
      deployments,
      () => {},
      first
    );
    expect(canonicalJson(second)).toBe(canonicalJson(first));
    expect(headerReads).toBe(2); // verification only, no binary search
  });

  it('rejects reused ranges the chain or the evidence does not confirm', async () => {
    const first = await buildRun(inventory, text, pinnedAt, readers, deployments);
    const lateEnd = {
      ...first,
      chains: first.chains.map((c) => ({
        ...c,
        toBlock: c.toBlock + 5000,
        toBlockTimestamp: c.toBlockTimestamp + 49802,
      })),
    };
    const a = await buildRun(inventory, text, pinnedAt, readers, deployments, () => {}, lateEnd);
    expect(a.chains).toHaveLength(0);
    expect(a.failures.find((f) => f.chainId === 8453)?.reason).toContain('!= recorded');

    const lateStart = {
      ...first,
      chains: first.chains.map((c) => ({...c, fromBlock: c.fromBlock + 1})),
    };
    const b = await buildRun(inventory, text, pinnedAt, readers, deployments, () => {}, lateStart);
    expect(b.chains).toHaveLength(0);
    expect(b.failures.find((f) => f.chainId === 8453)?.reason).toContain('!= evidence');
  });

  it('ignores a previous run with a different instant, inventory or permissions book', async () => {
    const first = await buildRun(inventory, text, pinnedAt, readers, deployments);
    const other = new Date(pinnedAt.getTime() + 1000);
    expect(reusableChains(first, other, first.inventorySha256).size).toBe(0);
    expect(reusableChains(first, pinnedAt, 'different').size).toBe(0);
    const stale = {...first, permissionsBook: {...first.permissionsBook, commit: 'old'}};
    expect(reusableChains(stale, pinnedAt, first.inventorySha256).size).toBe(0);
    expect(reusableChains(first, pinnedAt, first.inventorySha256).size).toBe(1);
  });

  it('serializes deterministically', async () => {
    const a = canonicalJson(await buildRun(inventory, text, pinnedAt, readers, deployments));
    const b = canonicalJson(await buildRun(inventory, text, pinnedAt, readers, deployments));
    expect(a).toBe(b);
    expect(a).toContain('"pinnedAt": "1970-01-01T03:16:40.000Z"');
  });
});
