import {describe, expect, it} from 'vitest';
import {canonicalJson, sha256} from './canonical';
import {chainById, EXCLUSIONS} from './chains';
import {PERMISSIONS_BOOK_PIN} from './permissionsBook';
import {RunManifest} from './ranges';
import {BalanceReader, buildBalances, chainHoldings} from './balances';
import {usdValue} from './usd';
import {Inventory, Target} from '../common/types';

const BASE = chainById(8453);
const POOL = '0x0000000000000000000000000000000000000001' as const;
const USDC = '0x0000000000000000000000000000000000000002' as const;
const AUSDC = '0x0000000000000000000000000000000000000003' as const;
const WETH = '0x0000000000000000000000000000000000000004' as const;
const AWETH = '0x0000000000000000000000000000000000000005' as const;
const ORACLE = '0x0000000000000000000000000000000000000006' as const;
const EXECUTOR = '0x9390B1735def18560c509E2d0bc090E9d6BA257a' as const;
const ACL = '0x00000000000000000000000000000000000000ac' as const;
const UNIT = 100_000_000n; // Aave V3 oracles quote USD with 8 decimals

const row = (over: Partial<Target>): Target => ({
  chainId: 8453,
  chainAlias: 'base',
  market: 'AaveV3Base',
  executor: EXECUTOR,
  aclAdmin: EXECUTOR,
  aclManager: ACL,
  oracle: ORACLE,
  governedByDao: true,
  targetType: 'aToken',
  target: AUSDC,
  underlying: USDC,
  symbol: 'USDC',
  decimals: 6,
  source: 'AaveV3Base.ASSETS.USDC',
  ...over,
});

const targets: Target[] = [
  row({
    targetType: 'pool',
    target: POOL,
    underlying: undefined,
    symbol: undefined,
    decimals: undefined,
    source: 'AaveV3Base.POOL',
  }),
  row({}),
  row({
    target: AWETH,
    underlying: WETH,
    symbol: 'WETH',
    decimals: 18,
    source: 'AaveV3Base.ASSETS.WETH',
  }),
  row({
    market: 'AaveV3BaseWhitelabel',
    governedByDao: false,
    aclAdmin: POOL,
    targetType: 'pool',
    target: '0x0000000000000000000000000000000000000009',
    underlying: undefined,
    symbol: undefined,
    decimals: undefined,
  }),
];

/** balances[token][holder], virtual[asset], price[asset]; anything unset is zero / no price. */
function fakeReader(
  balances: Record<string, Record<string, bigint>>,
  virtual: Record<string, bigint>,
  price: Record<string, bigint> = {[USDC]: UNIT, [WETH]: 2000n * UNIT},
  chainId = 8453
): BalanceReader {
  const k = (a: string) => a.toLowerCase();
  const lc = <T>(m: Record<string, T>) =>
    Object.fromEntries(Object.entries(m).map(([a, v]) => [k(a), v]));
  const b = Object.fromEntries(Object.entries(balances).map(([t, h]) => [k(t), lc(h)]));
  const v = lc(virtual);
  const p = lc(price);
  return {
    chainId: async () => chainId,
    balances: async (pairs) => pairs.map((x) => b[k(x.token)]?.[k(x.holder)] ?? 0n),
    virtualBalances: async (_pool, assets) => assets.map((a) => v[k(a)] ?? 0n),
    prices: async (_oracle, assets) => ({unit: UNIT, prices: assets.map((a) => p[k(a)])}),
  };
}

describe('usdValue', () => {
  it('scales by decimals and the oracle unit, keeping two decimals', () => {
    expect(usdValue(1_500_000n, 6, UNIT, UNIT)).toBe('1.50');
    expect(usdValue(10n ** 18n, 18, 2000n * UNIT, UNIT)).toBe('2000.00');
    expect(usdValue(-1_500_000n, 6, UNIT, UNIT)).toBe('-1.50');
    expect(usdValue(-2n, 6, UNIT, UNIT)).toBe('0.00'); // below one cent
    expect(usdValue(123_456_789n, 6, UNIT, UNIT)).toBe('123.45');
  });
});

describe('chainHoldings', () => {
  it('reports every market token in every aToken and the Pool, with surplus for own underlying', async () => {
    const reader = fakeReader(
      {
        [USDC]: {[AUSDC]: 1_000_000n, [POOL]: 25n, [AWETH]: 40n},
        [AUSDC]: {[AUSDC]: 7n, [POOL]: 3n},
        [WETH]: {[AWETH]: 500n, [AUSDC]: 11n},
        [AWETH]: {[AUSDC]: 2n},
      },
      {[USDC]: 999_000n, [WETH]: 500n}
    );
    const holdings = await chainHoldings(BASE, reader, targets, 100n);
    expect(holdings.map((h) => [h.kind, h.holderSymbol, h.tokenSymbol, h.amount])).toEqual([
      ['market-token-in-pool', 'Pool', 'USDC', '25'],
      ['market-token-in-pool', 'Pool', 'aUSDC', '3'],
      ['underlying-in-own-atoken', 'aUSDC', 'USDC', '1000'],
      ['atoken-in-itself', 'aUSDC', 'aUSDC', '7'],
      ['market-token-in-atoken', 'aUSDC', 'WETH', '11'],
      ['market-token-in-atoken', 'aUSDC', 'aWETH', '2'],
      ['market-token-in-atoken', 'aWETH', 'USDC', '40'],
    ]);
    const surplus = holdings.find((h) => h.kind === 'underlying-in-own-atoken')!;
    expect(surplus.virtualBalance).toBe('999000');
    expect(surplus.amountFormatted).toBe('0.001');
    expect(surplus.priceUsd).toBe('1');
    expect(surplus.valueUsd).toBe('0.00');
    const weth = holdings.find((h) => h.tokenSymbol === 'WETH')!;
    expect(weth.amountFormatted).toBe('0.000000000000000011');
    expect(weth.valueUsd).toBe('0.00');
    expect(holdings.every((h) => h.market === 'AaveV3Base')).toBe(true);
  });

  it('prices aTokens by their underlying and omits the price when the oracle has none', async () => {
    const reader = fakeReader(
      {[AWETH]: {[POOL]: 3n * 10n ** 18n}, [AUSDC]: {[POOL]: 5_000_000n}},
      {[USDC]: 0n, [WETH]: 0n},
      {[WETH]: 2000n * UNIT}
    );
    const holdings = await chainHoldings(BASE, reader, targets, 100n);
    const aweth = holdings.find((h) => h.tokenSymbol === 'aWETH')!;
    expect(aweth.valueUsd).toBe('6000.00');
    const ausdc = holdings.find((h) => h.tokenSymbol === 'aUSDC')!;
    expect(ausdc.priceUsd).toBeUndefined();
    expect(ausdc.valueUsd).toBeUndefined();
  });

  it('flags a surplus below zero and a zero virtual balance for review', async () => {
    const reader = fakeReader({[USDC]: {[AUSDC]: 10n}, [WETH]: {[AWETH]: 5n}}, {[USDC]: 12n});
    const holdings = await chainHoldings(BASE, reader, targets, 100n);
    const usdc = holdings.find((h) => h.tokenSymbol === 'USDC')!;
    expect(usdc.amount).toBe('-2');
    expect(usdc.note).toContain('below virtual');
    const weth = holdings.find((h) => h.tokenSymbol === 'WETH')!;
    expect(weth.amount).toBe('5');
    expect(weth.note).toContain('virtual balance is zero');
  });

  it('skips markets that are not DAO-governed', async () => {
    const reader = fakeReader({[USDC]: {'0x0000000000000000000000000000000000000009': 99n}}, {});
    expect(await chainHoldings(BASE, reader, targets, 100n)).toEqual([]);
  });

  it('issues one balance call per (market token, holder) pair', async () => {
    let pairs = 0;
    const reader = fakeReader({}, {});
    reader.balances = async (p) => {
      pairs += p.length;
      return p.map(() => 0n);
    };
    await chainHoldings(BASE, reader, targets, 100n);
    expect(pairs).toBe(4 * 3); // 2 reserves -> 4 tokens; holders: 2 aTokens + Pool
  });
});

describe('buildBalances', () => {
  const inventory: Inventory = {addressBook: {repository: 'x', commit: 'y', tag: 'z'}, targets};
  const inventoryText = canonicalJson(inventory);
  const base: RunManifest = {
    pinnedAt: '2026-09-01T00:00:00.000Z',
    inventorySha256: sha256(inventoryText),
    permissionsBook: {...PERMISSIONS_BOOK_PIN},
    chains: [
      {
        chainId: 8453,
        alias: 'base',
        fromBlock: 1,
        fromBlockSource: 'permissions-book',
        toBlock: 100,
        toBlockTimestamp: 1,
        markets: [],
      },
    ],
    failures: [],
    exclusions: [...EXCLUSIONS],
  };
  const runText = canonicalJson(base);
  const readers = (chain: {chainId: number}) =>
    chain.chainId === 8453 ? fakeReader({[USDC]: {[AUSDC]: 10n}}, {[USDC]: 4n}) : undefined;

  it('reads every pinned chain at its toBlock and records the rest as failures', async () => {
    const out = await buildBalances(inventory, inventoryText, base, runText, readers);
    expect(out.chains).toHaveLength(1);
    expect(out.chains[0].block).toBe(100);
    expect(out.chains[0].holdings.map((h) => h.amount)).toEqual(['6']);
    expect(out.failures).toHaveLength(20);
    expect(out.runSha256).toBe(sha256(runText));
  });

  it('refuses a run that is not final or that was pinned against another inventory', async () => {
    await expect(
      buildBalances(
        inventory,
        inventoryText,
        {...base, failures: [{chainId: 1, alias: 'mainnet', reason: 'x'}]},
        runText,
        readers
      )
    ).rejects.toThrow('not final');
    await expect(
      buildBalances(inventory, inventoryText, {...base, inventorySha256: 'other'}, runText, readers)
    ).rejects.toThrow('different inventory');
  });

  it('fails a chain whose RPC serves another chain id', async () => {
    const wrong = (chain: {chainId: number}) =>
      chain.chainId === 8453 ? fakeReader({}, {}, {}, 1) : undefined;
    const out = await buildBalances(inventory, inventoryText, base, runText, wrong);
    expect(out.chains).toHaveLength(0);
    expect(out.failures.find((f) => f.chainId === 8453)?.reason).toContain('serves chain 1');
  });

  it('serializes deterministically', async () => {
    const a = canonicalJson(await buildBalances(inventory, inventoryText, base, runText, readers));
    const b = canonicalJson(await buildBalances(inventory, inventoryText, base, runText, readers));
    expect(a).toBe(b);
  });
});
