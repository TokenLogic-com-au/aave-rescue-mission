import {describe, expect, it} from 'vitest';
import {encodeAbiParameters, pad, zeroAddress, type Hash} from 'viem';
import {
  adaptiveLogs,
  buildAttribution,
  LogReader,
  RawTransfer,
  Receipt,
  scanGroup,
  SurplusInput,
  verifySurplusGroup,
  TRANSFER_TOPIC,
} from './attribution';
import {BalancesManifest, Holding} from './balances';
import {canonicalJson, sha256} from './canonical';
import {chainById, EXCLUSIONS} from './chains';
import {filterBalances} from './filter';
import {PipelineInputs} from './inputs';
import {PERMISSIONS_BOOK_PIN} from './permissionsBook';
import {RunManifest} from './ranges';
import {SurplusHolding, SurplusManifest} from './surplus';
import {Inventory, Target} from '../common/types';
import {transferCents} from './usd';

const BASE = chainById(8453);
const POOL = '0x0000000000000000000000000000000000000001' as const;
const USDC = '0x0000000000000000000000000000000000000002' as const;
const AUSDC = '0x0000000000000000000000000000000000000003' as const;
const ALICE = '0x00000000000000000000000000000000000000A1' as const;
const BOB = '0x00000000000000000000000000000000000000B0' as const;
const ROUTER = '0x00000000000000000000000000000000000000eE' as const;
const TX = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as const;

const holding = (over: Partial<Holding> = {}): Holding => ({
  chainId: 8453,
  chainAlias: 'base',
  market: 'AaveV3Base',
  kind: 'atoken-in-itself',
  holder: AUSDC,
  holderSymbol: 'aUSDC',
  token: AUSDC,
  tokenSymbol: 'aUSDC',
  decimals: 6,
  amount: '3000000',
  amountFormatted: '3',
  priceUsd: '1',
  valueUsd: '3.00',
  ...over,
});

const range = {fromBlock: 100, toBlock: 200};
const PROTOCOL = new Set([POOL, AUSDC].map((a) => a.toLowerCase()));

type Log = RawTransfer & {token?: `0x${string}`};
type Fake = {
  chainId?: number;
  logs?: Log[];
  /** Receipt overrides by tx hash; by default the receipt carries exactly the fake logs of that tx, signed by tokenFrom. */
  receipts?: Record<string, Partial<Receipt>>;
};

const transferLog = (l: Log) => ({
  address: l.token ?? AUSDC,
  topics: [TRANSFER_TOPIC, pad(l.from, {size: 32}), pad(l.to, {size: 32})] as Hash[],
  data: encodeAbiParameters([{type: 'uint256'}], [l.value]),
  logIndex: l.logIndex,
});

/** Filters like a node: by token address and by the indexed party. */
function fakeReader(fake: Fake): LogReader {
  const logs = (fake.logs ?? []).map((l) => ({token: AUSDC, ...l}));
  return {
    chainId: async () => fake.chainId ?? 8453,
    transfers: async (token, side, party, from, to) =>
      logs
        .filter((l) => l.token === token && l[side] === party && l.block >= from && l.block <= to)
        .map(({token: _t, ...l}) => l),
    receipt: async (hash) => {
      const mine = logs.filter((l) => l.txHash === hash);
      if (!mine.length && !fake.receipts?.[hash]) throw new Error(`no receipt for ${hash}`);
      return {
        from: mine[0]?.from ?? ALICE,
        to: AUSDC,
        block: mine[0]?.block ?? 150n,
        logs: mine.map(transferLog),
        ...fake.receipts?.[hash],
      };
    },
  };
}

const raw = (n: number, from: `0x${string}`, value: bigint, over: Partial<Log> = {}): Log => ({
  block: 150n,
  txHash: TX(n),
  logIndex: n,
  from,
  to: AUSDC,
  value,
  ...over,
});

describe('scanGroup', () => {
  it('keeps tokenFrom and txFrom apart, aggregates per wallet, and reconciles exactly', async () => {
    const reader = fakeReader({
      logs: [raw(1, ALICE, 1_000_000n), raw(2, BOB, 1_500_000n), raw(3, ALICE, 500_000n)],
    });
    const group = await scanGroup(BASE, reader, holding(), range, PROTOCOL, 0);
    expect(group.evidence).toEqual({source: 'rpc-logs'});
    expect(group.transfers.map((t) => [t.tokenFrom, t.txFrom, t.txTo, t.outcome])).toEqual([
      [BOB, BOB, AUSDC, 'candidate'],
      [ALICE, ALICE, AUSDC, 'candidate'],
      [ALICE, ALICE, AUSDC, 'candidate'],
    ]);
    expect(group.wallets).toEqual([
      {tokenFrom: ALICE, amount: '1500000', amountFormatted: '1.5', valueUsd: '1.50', transfers: 2},
      {tokenFrom: BOB, amount: '1500000', amountFormatted: '1.5', valueUsd: '1.50', transfers: 1},
    ]);
    expect(group.reconciliation).toEqual({
      candidates: '3000000',
      review: '0',
      dust: '0',
      outflows: '0',
      delta: '0',
      status: 'reconciled',
    });
  });

  it('routes mints, protocol senders, zero values and intermediaries to manual review, candidates first, largest first', async () => {
    const reader = fakeReader({
      logs: [
        raw(1, zeroAddress, 5n),
        raw(2, POOL, 7n),
        raw(3, ALICE, 0n),
        raw(4, BOB, 100n),
        raw(5, ALICE, 1_000_000n),
        raw(6, BOB, 1_999_888n),
      ],
      receipts: {[TX(4)]: {from: ROUTER, to: ROUTER}},
    });
    const group = await scanGroup(BASE, reader, holding(), range, PROTOCOL, 0);
    expect(group.transfers.map((t) => [t.amount, t.outcome, t.reason])).toEqual([
      ['1999888', 'candidate', undefined],
      ['1000000', 'candidate', undefined],
      ['100', 'manual_review', 'sender is not the transaction signer: router, Safe or relayer'],
      ['7', 'manual_review', 'sent by a protocol contract of this market'],
      ['5', 'manual_review', 'minted directly into the holder'],
      ['0', 'manual_review', 'zero-value transfer'],
    ]);
    expect(group.wallets.map((w) => w.tokenFrom)).toEqual([BOB, ALICE]);
    expect(group.reconciliation).toMatchObject({review: '112', delta: '0', status: 'review'});
    expect(group.reconciliation.note).toBe('4 transfer(s) need manual review');
  });

  it('never reconciles a group with outflows, even when the totals match', async () => {
    const reader = fakeReader({
      logs: [
        raw(1, ALICE, 100n, {block: 110n}),
        raw(2, AUSDC, 100n, {block: 120n, to: ALICE}),
        raw(3, BOB, 100n, {block: 130n}),
      ],
    });
    const group = await scanGroup(BASE, reader, holding({amount: '100'}), range, PROTOCOL, 0);
    expect(group.outflows).toEqual([
      {block: 120, txHash: TX(2), logIndex: 2, to: ALICE, amount: '100'},
    ]);
    expect(group.reconciliation).toMatchObject({
      outflows: '100',
      dust: '0',
      delta: '0',
      status: 'review',
    });
    expect(group.reconciliation.note).toContain('already refunded');
  });

  it('explains a positive delta by interest when the token is an aToken of the market', async () => {
    const inPool = holding({kind: 'market-token-in-pool', holder: POOL, holderSymbol: 'Pool'});
    const withInterest = await scanGroup(
      BASE,
      fakeReader({logs: [raw(1, ALICE, 2_000_000n, {to: POOL})]}),
      inPool,
      range,
      PROTOCOL,
      0
    );
    expect(withInterest.reconciliation.delta).toBe('1000000');
    expect(withInterest.reconciliation.note).toContain('accrued interest');
    const plain = await scanGroup(
      BASE,
      fakeReader({logs: [raw(1, ALICE, 2_000_000n)]}),
      holding(),
      range,
      new Set(),
      0
    );
    expect(plain.reconciliation.note).toContain('before the window or unexplained inflow');
  });

  it('flags a balance below the attributed transfers', async () => {
    const group = await scanGroup(
      BASE,
      fakeReader({logs: [raw(1, ALICE, 5_000_000n)]}),
      holding(),
      range,
      PROTOCOL,
      0
    );
    expect(group.reconciliation.delta).toBe('-2000000');
    expect(group.reconciliation.note).toContain('unexplained outflow');
  });

  it('only scans the pinned window and the holding token', async () => {
    const reader = fakeReader({
      logs: [
        raw(1, ALICE, 1n, {block: 99n}),
        raw(2, ALICE, 2n),
        raw(3, ALICE, 4n, {block: 201n}),
        raw(4, ALICE, 8n, {token: USDC}),
      ],
    });
    const group = await scanGroup(BASE, reader, holding({amount: '2'}), range, PROTOCOL, 0);
    expect(group.transfers.map((t) => t.amount)).toEqual(['2']);
    expect(group.reconciliation.status).toBe('reconciled');
  });

  it('leaves valueUsd out for unpriced groups', async () => {
    const group = await scanGroup(
      BASE,
      fakeReader({logs: [raw(1, ALICE, 3_000_000n)]}),
      holding({valueUsd: undefined, priceUsd: undefined}),
      range,
      PROTOCOL,
      0
    );
    expect(group.balanceUsd).toBeUndefined();
    expect(group.wallets[0].valueUsd).toBeUndefined();
  });
});

describe('dust floor', () => {
  it('values transfers at the pinned oracle price in cents without floats', () => {
    expect(transferCents(1_000_000n, 6, '1')).toBe(100n);
    expect(transferCents(1_000_000n, 6, '0.99987')).toBe(99n);
    expect(transferCents(5n, 6, '1')).toBe(0n);
    expect(transferCents(10n ** 18n, 18, '2345.678912345')).toBe(234567n);
  });

  it('records transfers under the floor as dust, reads no receipt, and keeps them in the totals', async () => {
    let receipts = 0;
    const base = fakeReader({
      logs: [raw(1, ALICE, 2_000_000n), raw(2, BOB, 5n), raw(3, ROUTER, 999_999n)],
    });
    const reader: LogReader = {...base, receipt: (h) => (receipts++, base.receipt(h))};
    const group = await scanGroup(BASE, reader, holding({amount: '3000004'}), range, PROTOCOL, 1);
    expect(receipts).toBe(1);
    expect(group.transfers.map((t) => [t.amount, t.outcome, t.txFrom])).toEqual([
      ['2000000', 'candidate', ALICE],
      ['999999', 'dust', null],
      ['5', 'dust', null],
    ]);
    expect(group.transfers[1].reason).toContain('below 1 USD');
    expect(group.wallets.map((w) => w.tokenFrom)).toEqual([ALICE]);
    expect(group.reconciliation).toMatchObject({
      candidates: '2000000',
      dust: '1000004',
      delta: '0',
      status: 'reconciled',
    });
  });

  it('verifies everything when the holding has no oracle price', async () => {
    let receipts = 0;
    const base = fakeReader({logs: [raw(1, ALICE, 5n)]});
    const reader: LogReader = {...base, receipt: (h) => (receipts++, base.receipt(h))};
    const group = await scanGroup(
      BASE,
      reader,
      holding({amount: '5', priceUsd: undefined, valueUsd: undefined}),
      range,
      PROTOCOL,
      1
    );
    expect(receipts).toBe(1);
    expect(group.transfers[0].outcome).toBe('candidate');
  });

  it('skips receipts for dust Dune rows and counts only verified ones', async () => {
    const surplusHolding = holding({
      kind: 'underlying-in-own-atoken',
      token: USDC,
      tokenSymbol: 'USDC',
      amount: '2000005',
      valueUsd: '2.00',
    });
    const logs = [raw(1, ALICE, 2_000_000n, {token: USDC}), raw(2, BOB, 5n, {token: USDC})];
    let receipts = 0;
    const base = fakeReader({logs, receipts: {[TX(1)]: {to: USDC}, [TX(2)]: {to: USDC}}});
    const reader: LogReader = {...base, receipt: (h) => (receipts++, base.receipt(h))};
    const entry = {
      chainId: 8453,
      chainAlias: 'base',
      market: 'AaveV3Base',
      holder: AUSDC,
      token: USDC,
      fromBlock: 100,
      toBlock: 200,
      executions: [{id: 'e', fromTime: 'a', toTime: 'b'}],
      rows: logs.map((l) => ({
        block: 150,
        txHash: l.txHash,
        logIndex: l.logIndex,
        tokenFrom: l.from,
        amount: l.value.toString(),
        txFrom: l.from,
        txTo: USDC,
      })),
    };
    const group = await verifySurplusGroup(
      BASE,
      reader,
      surplusHolding,
      entry,
      POOL,
      PROTOCOL,
      's',
      1
    );
    expect(receipts).toBe(1);
    expect(group.evidence).toMatchObject({receiptsVerified: 1});
    expect(group.reconciliation).toMatchObject({
      candidates: '2000000',
      dust: '5',
      status: 'reconciled',
    });
  });
});

describe('verifySurplusGroup', () => {
  const surplusHolding = holding({
    kind: 'underlying-in-own-atoken',
    token: USDC,
    tokenSymbol: 'USDC',
    amount: '2500000',
    amountFormatted: '2.5',
    valueUsd: '2.50',
    virtualBalance: '1000000000',
  });
  const entry = (rows: SurplusHolding['rows']): SurplusHolding => ({
    chainId: 8453,
    chainAlias: 'base',
    market: 'AaveV3Base',
    holder: AUSDC,
    token: USDC,
    fromBlock: 100,
    toBlock: 200,
    executions: [{id: 'exec-1', fromTime: '2024-01-01 00:00:00', toTime: '2024-04-01 00:00:00'}],
    rows,
  });
  const row = (
    n: number,
    from: `0x${string}`,
    amount: bigint,
    over: Partial<SurplusHolding['rows'][0]> = {}
  ) => ({
    block: 150,
    txHash: TX(n),
    logIndex: n,
    tokenFrom: from,
    amount: amount.toString(),
    txFrom: from,
    txTo: USDC,
    ...over,
  });
  const receiptsFor = (logs: Log[]) =>
    fakeReader({
      logs: logs.map((l) => ({...l, token: USDC})),
      receipts: Object.fromEntries(logs.map((l) => [l.txHash, {to: USDC}])),
    });

  it('accepts rows whose receipts prove the transfer and show no Pool or aToken log', async () => {
    const reader = receiptsFor([raw(1, ALICE, 2_000_000n), raw(2, BOB, 500_000n)]);
    const group = await verifySurplusGroup(
      BASE,
      reader,
      surplusHolding,
      entry([row(1, ALICE, 2_000_000n), row(2, BOB, 500_000n)]),
      POOL,
      PROTOCOL,
      'sql-sha',
      0
    );
    expect(group.evidence).toEqual({
      source: 'dune-anti-join',
      executionIds: ['exec-1'],
      sqlSha256: 'sql-sha',
      receiptsVerified: 2,
    });
    expect(group.wallets.map((w) => [w.tokenFrom, w.amount, w.valueUsd])).toEqual([
      [ALICE, '2000000', '2.00'],
      [BOB, '500000', '0.50'],
    ]);
    expect(group.reconciliation.status).toBe('reconciled');
  });

  it('fails the chain when a receipt contradicts a Dune row', async () => {
    const cases: [Partial<SurplusHolding['rows'][0]>, Partial<Receipt> | undefined, string][] = [
      [{amount: '1'}, undefined, 'does not contain the Transfer'],
      [{tokenFrom: BOB}, undefined, 'does not contain the Transfer'],
      [{block: 151}, undefined, 'receipt block differs'],
      [{txFrom: BOB}, undefined, 'signer or target differs'],
      [
        {},
        {
          logs: [
            transferLog({...raw(1, ALICE, 2_500_000n), token: USDC}),
            {address: POOL, topics: [TX(9)], data: '0x', logIndex: 2},
          ],
        },
        'emitted a Pool log',
      ],
    ];
    for (const [over, receipt, message] of cases) {
      const reader = fakeReader({
        logs: [{...raw(1, ALICE, 2_500_000n), token: USDC}],
        receipts: {[TX(1)]: {to: USDC, ...receipt}},
      });
      await expect(
        verifySurplusGroup(
          BASE,
          reader,
          surplusHolding,
          entry([row(1, ALICE, 2_500_000n, over)]),
          POOL,
          PROTOCOL,
          's',
          0
        )
      ).rejects.toThrow(message);
    }
  });

  it('fails the chain on a row outside the window or listed twice', async () => {
    const reader = receiptsFor([raw(1, ALICE, 2_500_000n)]);
    await expect(
      verifySurplusGroup(
        BASE,
        reader,
        surplusHolding,
        entry([row(1, ALICE, 2_500_000n, {block: 99})]),
        POOL,
        PROTOCOL,
        's',
        0
      )
    ).rejects.toThrow('outside 100..200');
    await expect(
      verifySurplusGroup(
        BASE,
        reader,
        surplusHolding,
        entry([row(1, ALICE, 2_500_000n), row(1, ALICE, 2_500_000n)]),
        POOL,
        PROTOCOL,
        's',
        0
      )
    ).rejects.toThrow('listed twice');
  });

  it('explains deltas in surplus terms and tracks no outflows', async () => {
    const reader = receiptsFor([raw(1, ALICE, 1_000_000n)]);
    const group = await verifySurplusGroup(
      BASE,
      reader,
      surplusHolding,
      entry([row(1, ALICE, 1_000_000n)]),
      POOL,
      PROTOCOL,
      's',
      0
    );
    expect(group.outflows).toEqual([]);
    expect(group.reconciliation.delta).toBe('1500000');
    expect(group.reconciliation.note).toContain('surplus exceeds attributed transfers');
  });
});

describe('adaptiveLogs', () => {
  it('halves the range until the provider accepts it and keeps the results in order', async () => {
    const calls: [bigint, bigint][] = [];
    const out = await adaptiveLogs(
      async (from, to) => {
        calls.push([from, to]);
        if (to - from > 3n) throw new Error('range too large');
        return Array.from({length: Number(to - from) + 1}, (_, i) => from + BigInt(i));
      },
      0n,
      15n
    );
    expect(out).toEqual(Array.from({length: 16}, (_, i) => BigInt(i)));
    expect(calls[0]).toEqual([0n, 15n]);
    expect(calls.every(([f, t]) => f <= t)).toBe(true);
  });

  it('gives up at a single block', async () => {
    await expect(
      adaptiveLogs(async () => Promise.reject(new Error('unauthorized')), 0n, 7n)
    ).rejects.toThrow('unauthorized');
  });
});

describe('buildAttribution', () => {
  const targets: Target[] = (['pool', 'aToken'] as const).map((targetType) => ({
    chainId: 8453,
    chainAlias: 'base',
    market: 'AaveV3Base',
    executor: '0x9390B1735def18560c509E2d0bc090E9d6BA257a',
    aclAdmin: '0x9390B1735def18560c509E2d0bc090E9d6BA257a',
    aclManager: '0x00000000000000000000000000000000000000ac',
    oracle: '0x00000000000000000000000000000000000000ac',
    governedByDao: true,
    targetType,
    target: targetType === 'pool' ? POOL : AUSDC,
    source: 'AaveV3Base',
  }));
  const inventory: Inventory = {addressBook: {repository: 'x', commit: 'y', tag: 'z'}, targets};
  const inventoryText = canonicalJson(inventory);
  const run: RunManifest = {
    pinnedAt: '2026-09-01T00:00:00.000Z',
    inventorySha256: sha256(inventoryText),
    permissionsBook: {...PERMISSIONS_BOOK_PIN},
    chains: [
      {
        chainId: 8453,
        alias: 'base',
        fromBlock: 100,
        fromBlockSource: 'permissions-book',
        toBlock: 200,
        toBlockTimestamp: 1,
        markets: [],
      },
    ],
    failures: [],
    exclusions: [...EXCLUSIONS],
  };
  const runText = canonicalJson(run);
  const surplusHolding = holding({
    kind: 'underlying-in-own-atoken',
    token: USDC,
    tokenSymbol: 'USDC',
    amount: '5',
    valueUsd: '5000.00',
  });
  const unpricedHolding = holding({
    kind: 'market-token-in-pool',
    holder: POOL,
    holderSymbol: 'Pool',
    token: USDC,
    tokenSymbol: 'NOPRICE',
    amount: '9',
    valueUsd: undefined,
    priceUsd: undefined,
  });
  const balances: BalancesManifest = {
    runSha256: sha256(runText),
    inventorySha256: sha256(inventoryText),
    chains: [
      {
        chainId: 8453,
        alias: 'base',
        block: 200,
        holdings: [
          holding({amount: '1000000', valueUsd: '1000.00'}),
          surplusHolding,
          unpricedHolding,
        ],
      },
    ],
    failures: [],
  };
  const balancesText = canonicalJson(balances);
  const filtered = filterBalances(balances, balancesText);
  const filteredText = canonicalJson(filtered);
  const inputs = (over: Partial<PipelineInputs> = {}): PipelineInputs => ({
    inventory,
    inventoryText,
    run,
    runText,
    balances,
    balancesText,
    filtered,
    filteredText,
    ...over,
  });
  const readers = (chain: {chainId: number}) =>
    chain.chainId === 8453
      ? fakeReader({
          logs: [
            raw(1, ALICE, 1_000_000n),
            raw(2, BOB, 9n, {token: USDC, to: POOL}),
            raw(3, BOB, 5n, {token: USDC}),
          ],
          receipts: {[TX(3)]: {to: USDC}},
        })
      : undefined;
  const surplusManifest: SurplusManifest = {
    filteredSha256: sha256(filteredText),
    sqlSha256: sha256('select 1'),
    holdings: [
      {
        chainId: 8453,
        chainAlias: 'base',
        market: 'AaveV3Base',
        holder: AUSDC,
        token: USDC,
        fromBlock: 100,
        toBlock: 200,
        executions: [
          {id: 'exec-1', fromTime: '2024-01-01 00:00:00', toTime: '2024-04-01 00:00:00'},
        ],
        rows: [
          {
            block: 150,
            txHash: TX(3),
            logIndex: 3,
            tokenFrom: BOB,
            amount: '5',
            txFrom: BOB,
            txTo: USDC,
          },
        ],
      },
    ],
    failures: [],
  };
  const surplus = (over: Partial<SurplusManifest> = {}): SurplusInput => {
    const manifest = {...surplusManifest, ...over};
    return {manifest, text: canonicalJson(manifest), sqlText: 'select 1'};
  };

  it('defers surplus holdings without a surplus file and attributes the rest', async () => {
    const out = await buildAttribution(inputs(), undefined, readers, 0);
    expect(out.surplus).toBeUndefined();
    expect(out.filteredSha256).toBe(sha256(filteredText));
    expect(out.runSha256).toBe(sha256(runText));
    expect(out.groups.map((g) => [g.kind, g.tokenSymbol, g.reconciliation.status])).toEqual([
      ['atoken-in-itself', 'aUSDC', 'reconciled'],
      ['market-token-in-pool', 'NOPRICE', 'reconciled'],
    ]);
    expect(out.deferred).toEqual([surplusHolding]);
    expect(out.failures).toEqual([]);
  });

  it('puts all four kinds in one manifest when the surplus file matches', async () => {
    const s = surplus();
    const out = await buildAttribution(inputs(), s, readers, 0);
    expect(out.surplus).toEqual({sha256: sha256(s.text), sqlSha256: sha256('select 1')});
    expect(out.minTransferUsd).toBe(0);
    expect(out.groups.map((g) => [g.kind, g.evidence.source, g.reconciliation.status])).toEqual([
      ['atoken-in-itself', 'rpc-logs', 'reconciled'],
      ['underlying-in-own-atoken', 'dune-anti-join', 'reconciled'],
      ['market-token-in-pool', 'rpc-logs', 'reconciled'],
    ]);
    expect(out.deferred).toEqual([]);
  });

  it('fails the chain when a supplied surplus file does not cover a holding for this window', async () => {
    const stale = surplus({holdings: [{...surplusManifest.holdings[0], toBlock: 199}]});
    const out = await buildAttribution(inputs(), stale, readers, 0);
    expect(out.deferred).toEqual([]);
    expect(out.failures.map((f) => f.reason)).toEqual([
      'surplus-transfers.json has no rows for aUSDC/USDC over 100..200',
    ]);
  });

  it('refuses a surplus file built from another filtered file or another SQL', async () => {
    await expect(
      buildAttribution(inputs(), surplus({filteredSha256: 'x'}), readers, 0)
    ).rejects.toThrow('another filtered file');
    await expect(buildAttribution(inputs(), surplus({sqlSha256: 'x'}), readers, 0)).rejects.toThrow(
      'another surplus.sql'
    );
  });

  it('refuses a surplus file with failures', async () => {
    await expect(
      buildAttribution(
        inputs(),
        surplus({
          failures: [{chainId: 8453, alias: 'base', holder: AUSDC, token: USDC, reason: 'x'}],
        }),
        readers,
        0
      )
    ).rejects.toThrow('surplus-transfers.json is not final');
  });

  it('records a chain-level failure and never drops holdings silently', async () => {
    const out = await buildAttribution(inputs(), undefined, () => undefined, 0);
    expect(out.groups).toEqual([]);
    expect(out.failures.map((f) => f.alias)).toEqual(['base']);
  });
});
