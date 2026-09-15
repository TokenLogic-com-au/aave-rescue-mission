import {describe, expect, it} from 'vitest';
import {canonicalJson, sha256} from './canonical';
import {chainById, EXCLUSIONS} from './chains';
import {fakeChain} from './chain.fake';
import {PERMISSIONS_BOOK_PIN} from './permissionsBook';
import {RunManifest} from './ranges';
import {buildBalances, chainScan} from './balances';
import {usdValue} from './usd';
import {Inventory, Market} from '../common/types';

const BASE = chainById(8453);
const POOL = '0x0000000000000000000000000000000000000001' as const;
const USDC = '0x0000000000000000000000000000000000000002' as const;
const AUSDC = '0x0000000000000000000000000000000000000003' as const;
const WETH = '0x0000000000000000000000000000000000000004' as const;
const AWETH = '0x0000000000000000000000000000000000000005' as const;
const ORACLE = '0x0000000000000000000000000000000000000006' as const;
const HUB = '0x0000000000000000000000000000000000000007' as const;
const SPOKE = '0x0000000000000000000000000000000000000008' as const;
const OTHER_POOL = '0x0000000000000000000000000000000000000009' as const;
const EXECUTOR = '0x9390B1735def18560c509E2d0bc090E9d6BA257a' as const;
const ACL = '0x00000000000000000000000000000000000000ac' as const;
const UNIT = 100_000_000n; // Aave V3 oracles quote USD with 8 decimals

const v3: Market = {
  market: 'AaveV3Base',
  protocol: 'v3',
  chainId: 8453,
  chainAlias: 'base',
  oracle: ORACLE,
  authority: {executor: EXECUTOR, aclAdmin: EXECUTOR, aclManager: ACL, governedByDao: true},
  holders: [
    {name: 'Pool', address: POOL, role: 'pool', source: 'AaveV3Base.POOL'},
    {
      name: 'aUSDC',
      address: AUSDC,
      role: 'aToken',
      floor: {rule: 'virtualBalance', pool: POOL, token: USDC},
      source: 'AaveV3Base.ASSETS.USDC',
    },
    {
      name: 'aWETH',
      address: AWETH,
      role: 'aToken',
      floor: {rule: 'virtualBalance', pool: POOL, token: WETH},
      source: 'AaveV3Base.ASSETS.WETH',
    },
  ],
  tokens: [
    {address: USDC, symbol: 'USDC', decimals: 6, pricedBy: USDC, source: 'AaveV3Base.ASSETS.USDC'},
    {
      address: AUSDC,
      symbol: 'aUSDC',
      decimals: 6,
      pricedBy: USDC,
      source: 'AaveV3Base.ASSETS.USDC',
    },
    {address: WETH, symbol: 'WETH', decimals: 18, pricedBy: WETH, source: 'AaveV3Base.ASSETS.WETH'},
    {
      address: AWETH,
      symbol: 'aWETH',
      decimals: 18,
      pricedBy: WETH,
      source: 'AaveV3Base.ASSETS.WETH',
    },
  ],
};
const whitelabel: Market = {
  ...v3,
  market: 'AaveV3BaseWhitelabel',
  authority: {...v3.authority!, aclAdmin: POOL, governedByDao: false},
  holders: [{name: 'Pool', address: OTHER_POOL, role: 'pool', source: 'AaveV3BaseWhitelabel.POOL'}],
};
const v4: Market = {
  market: 'AaveV4Base',
  protocol: 'v4',
  chainId: 8453,
  chainAlias: 'base',
  oracle: ORACLE,
  holders: [
    {
      name: 'CORE_HUB',
      address: HUB,
      role: 'hub',
      floor: {rule: 'hubLiquidity'},
      source: 'AaveV4Base.HUBS.CORE_HUB',
    },
    {name: 'MAIN_SPOKE', address: SPOKE, role: 'spoke', source: 'AaveV4Base.SPOKES.MAIN_SPOKE'},
  ],
  tokens: [
    {address: USDC, symbol: 'USDC', decimals: 6, pricedBy: USDC, source: 'AaveV4Base.ASSETS.USDC'},
  ],
};
const inventory: Inventory = {
  addressBook: {repository: 'x', commit: 'y', tag: 'z'},
  markets: [v3, whitelabel],
};

type Fixture = {
  /** balances[token][holder] */
  balances?: Record<string, Record<string, bigint>>;
  /** Pool virtual balance per asset. */
  virtual?: Record<string, bigint>;
  /** Oracle price per asset; unset means the oracle has no price. */
  price?: Record<string, bigint>;
  /** Hub-listed assets: [underlying, decimals, liquidity]. */
  hub?: [string, number, bigint][];
  chainId?: number;
};

/** A reader answering the view calls discovery makes; anything unset is zero. */
function fakeReader(f: Fixture, onCall?: (name: string) => void) {
  const k = (a: unknown) => String(a).toLowerCase();
  const lc = <T>(m: Record<string, T> = {}) =>
    Object.fromEntries(Object.entries(m).map(([a, v]) => [k(a), v]));
  const balances = Object.fromEntries(
    Object.entries(f.balances ?? {}).map(([t, h]) => [k(t), lc(h)])
  );
  const virtual = lc(f.virtual);
  const price = lc(f.price ?? {[USDC]: UNIT, [WETH]: 2000n * UNIT});
  const hub = f.hub ?? [];
  return fakeChain({
    chainId: f.chainId,
    read: (call) => {
      onCall?.(call.functionName);
      const [a0] = call.args ?? [];
      switch (call.functionName) {
        case 'balanceOf':
          return balances[k(call.address)]?.[k(a0)] ?? 0n;
        case 'getVirtualUnderlyingBalance':
          return virtual[k(a0)] ?? 0n;
        case 'BASE_CURRENCY_UNIT':
          return UNIT;
        case 'getAssetPrice':
          return price[k(a0)];
        case 'getAssetCount':
          return BigInt(hub.length);
        case 'getAssetUnderlyingAndDecimals':
          return [hub[Number(a0)][0], hub[Number(a0)][1]];
        case 'getAssetLiquidity':
          return hub[Number(a0)][2];
        case 'getAssetAccruedFees':
          return 0n;
        default:
          return undefined;
      }
    },
  });
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

describe('chainScan', () => {
  it('reports every market token in every aToken and the Pool, with surplus for own underlying', async () => {
    const reader = fakeReader({
      balances: {
        [USDC]: {[AUSDC]: 1_000_000n, [POOL]: 25n, [AWETH]: 40n},
        [AUSDC]: {[AUSDC]: 7n, [POOL]: 3n},
        [WETH]: {[AWETH]: 500n, [AUSDC]: 11n},
        [AWETH]: {[AUSDC]: 2n},
      },
      virtual: {[USDC]: 999_000n, [WETH]: 500n},
    });
    const {holdings} = await chainScan(BASE, reader, inventory, 100n);
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
    const reader = fakeReader({
      balances: {[AWETH]: {[POOL]: 3n * 10n ** 18n}, [AUSDC]: {[POOL]: 5_000_000n}},
      price: {[WETH]: 2000n * UNIT},
    });
    const {holdings} = await chainScan(BASE, reader, inventory, 100n);
    const aweth = holdings.find((h) => h.tokenSymbol === 'aWETH')!;
    expect(aweth.valueUsd).toBe('6000.00');
    const ausdc = holdings.find((h) => h.tokenSymbol === 'aUSDC')!;
    expect(ausdc.priceUsd).toBeUndefined();
    expect(ausdc.valueUsd).toBeUndefined();
  });

  it('flags a surplus below zero and a zero virtual balance for review', async () => {
    const reader = fakeReader({
      balances: {[USDC]: {[AUSDC]: 10n}, [WETH]: {[AWETH]: 5n}},
      virtual: {[USDC]: 12n},
    });
    const {holdings} = await chainScan(BASE, reader, inventory, 100n);
    const usdc = holdings.find((h) => h.tokenSymbol === 'USDC')!;
    expect(usdc.amount).toBe('-2');
    expect(usdc.note).toContain('below virtual');
    const weth = holdings.find((h) => h.tokenSymbol === 'WETH')!;
    expect(weth.amount).toBe('5');
    expect(weth.note).toContain('virtual balance is zero');
  });

  it('skips V3 markets that are not DAO-governed', async () => {
    const reader = fakeReader({balances: {[USDC]: {[OTHER_POOL]: 99n}}});
    expect((await chainScan(BASE, reader, inventory, 100n)).holdings).toEqual([]);
  });

  it('issues one balance call per (token, holder) pair and reports it as coverage', async () => {
    let calls = 0;
    const reader = fakeReader({}, (name) => name === 'balanceOf' && calls++);
    const scan = await chainScan(BASE, reader, inventory, 100n);
    expect(calls).toBe(4 * 3); // 4 tokens; holders: 2 aTokens + Pool
    expect(scan.markets.map((m) => [m.market.market, m.checks])).toEqual([['AaveV3Base', 12]]);
  });

  it('scans a V4 market with the same rules: hub surplus over liquidity, anything in a spoke stuck', async () => {
    const reader = fakeReader({
      balances: {[USDC]: {[HUB]: 1_000_500n, [SPOKE]: 1_001_000_000n}},
      hub: [[USDC, 6, 1_000_000n]],
    });
    const scan = await chainScan(BASE, reader, {...inventory, markets: [v3, v4]}, 100n);
    expect(
      scan.holdings.map((h) => [
        h.kind,
        h.holderSymbol,
        h.tokenSymbol,
        h.amount,
        h.virtualBalance,
        h.valueUsd,
      ])
    ).toEqual([
      ['underlying-in-own-hub', 'CORE_HUB', 'USDC', '500', '1000000', '0.00'],
      ['market-token-in-v4-contract', 'MAIN_SPOKE', 'USDC', '1001000000', undefined, '1001.00'],
    ]);
    const v4scan = scan.markets.find((m) => m.market.protocol === 'v4')!;
    expect(v4scan.hubAssets.map((a) => [a.hubName, a.symbol, a.assetId, a.liquidity])).toEqual([
      ['CORE_HUB', 'USDC', 0, 1_000_000n],
    ]);
    expect(v4scan.checks).toBe(2);
  });

  it('scans an asset a hub lists after the address-book pin, named from chain', async () => {
    const base = fakeReader({balances: {[WETH]: {[HUB]: 3n}}, hub: [[WETH, 18, 1n]]});
    const reader = {
      ...base,
      read: async (calls: Parameters<typeof base.read>[0], block?: bigint) =>
        (await base.read(calls, block)).map((v, i) =>
          calls[i].functionName === 'symbol' ? 'WETH' : v
        ),
    };
    const {holdings} = await chainScan(BASE, reader, {...inventory, markets: [v4]}, 100n);
    expect(holdings.map((h) => [h.kind, h.tokenSymbol, h.amount, h.virtualBalance])).toEqual([
      ['underlying-in-own-hub', 'WETH', '2', '1'],
    ]);
  });
});

describe('buildBalances', () => {
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
    chain.chainId === 8453
      ? fakeReader({balances: {[USDC]: {[AUSDC]: 10n}}, virtual: {[USDC]: 4n}})
      : undefined;

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
      chain.chainId === 8453 ? fakeReader({chainId: 1}) : undefined;
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
