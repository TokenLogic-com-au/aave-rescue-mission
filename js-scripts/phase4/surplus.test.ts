import fs from 'fs';
import {describe, expect, it} from 'vitest';
import {
  awaitExecution,
  buildSurplus,
  DuneClient,
  DuneRow,
  duneClient,
  parseRows,
  querySlice,
  renderSql,
  retryAfterMs,
  slices,
  SURPLUS_SQL_PATH,
  timestampLiteral,
} from './surplus';
import {canonicalJson, sha256} from './canonical';
import {chainById} from './chains';
import {PipelineInputs} from './inputs';

const POOL = '0x0000000000000000000000000000000000000001' as const;
const USDC = '0x0000000000000000000000000000000000000002' as const;
const AUSDC = '0x0000000000000000000000000000000000000003' as const;
const ALICE = '0x00000000000000000000000000000000000000A1' as const;
const TX = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as const;
const template = fs.readFileSync(SURPLUS_SQL_PATH, 'utf8');
const SLICE = {fromTime: '2024-01-01 00:00:00', toTime: '2024-03-31 00:00:00'};

describe('renderSql', () => {
  it('fills every placeholder from the committed template with lower-case hex literals', () => {
    const sql = renderSql(
      template,
      chainById(1),
      {holder: AUSDC, token: USDC},
      POOL,
      {
        fromBlock: 10,
        toBlock: 20,
      },
      SLICE
    );
    expect(sql).not.toMatch(/\{\{/);
    expect(sql).toContain('FROM ethereum.logs');
    expect(sql).toContain(`contract_address = ${USDC}`);
    expect(sql).toContain(`topic2 = 0x${'0'.repeat(24)}${AUSDC.slice(2)}`);
    expect(sql).toContain(`bool_or(contract_address = ${POOL})`);
    expect(sql).toContain(`OR contract_address = ${POOL}`);
    expect(sql).toContain('BETWEEN 10 AND 20');
    expect(sql).toContain("block_time >= TIMESTAMP '2024-01-01 00:00:00'");
    expect(sql).toContain("block_time < TIMESTAMP '2024-03-31 00:00:00'");
  });

  it('refuses chains Dune does not index and unknown placeholders', () => {
    expect(() =>
      renderSql(
        template,
        chainById(143),
        {holder: AUSDC, token: USDC},
        POOL,
        {
          fromBlock: 1,
          toBlock: 2,
        },
        SLICE
      )
    ).toThrow('no logs table');
    expect(() =>
      renderSql(
        '{{nope}}',
        chainById(1),
        {holder: AUSDC, token: USDC},
        POOL,
        {
          fromBlock: 1,
          toBlock: 2,
        },
        SLICE
      )
    ).toThrow('unknown parameter nope');
  });
});

describe('parseRows', () => {
  const row = (over: Partial<DuneRow> = {}): DuneRow => ({
    block_number: 150,
    tx_hash: TX(1),
    index: 3,
    from_topic: `0x${'0'.repeat(24)}${ALICE.slice(2)}`,
    amount: `0x${5n.toString(16).padStart(64, '0')}`,
    tx_from: ALICE.toLowerCase(),
    tx_to: USDC,
    ...over,
  });

  it('decodes hex columns, checksums addresses and orders by position', () => {
    expect(parseRows([row({block_number: 160, index: 1}), row()])).toEqual([
      {
        block: 150,
        txHash: TX(1),
        logIndex: 3,
        tokenFrom: ALICE,
        amount: '5',
        txFrom: ALICE,
        txTo: USDC,
      },
      {
        block: 160,
        txHash: TX(1),
        logIndex: 1,
        tokenFrom: ALICE,
        amount: '5',
        txFrom: ALICE,
        txTo: USDC,
      },
    ]);
    expect(parseRows([row({tx_to: null})])[0].txTo).toBeNull();
  });

  it('rejects a row listed twice', () => {
    expect(() => parseRows([row(), row()])).toThrow('twice');
  });

  it('rejects malformed values', () => {
    expect(() => parseRows([row({amount: '5'})])).toThrow('non-hex amount');
    expect(() => parseRows([row({from_topic: null})])).toThrow('non-hex from_topic');
  });
});

describe('awaitExecution', () => {
  const client = (states: string[]): DuneClient => ({
    execute: async () => 'e',
    state: async () => ({state: states.shift() ?? 'QUERY_STATE_COMPLETED', error: 'boom'}),
    rows: async () => [],
  });
  const noSleep = async () => {};

  it('waits through pending and executing', async () => {
    await expect(
      awaitExecution(client(['QUERY_STATE_PENDING', 'QUERY_STATE_EXECUTING']), 'e', noSleep)
    ).resolves.toBeUndefined();
  });

  it('fails on terminal non-success states and on timeout', async () => {
    await expect(awaitExecution(client(['QUERY_STATE_FAILED']), 'e', noSleep)).rejects.toThrow(
      'QUERY_STATE_FAILED: boom'
    );
    await expect(
      awaitExecution(client(['QUERY_STATE_COMPLETED_PARTIAL']), 'e', noSleep)
    ).rejects.toThrow('COMPLETED_PARTIAL');
    await expect(
      awaitExecution(client(Array(3).fill('QUERY_STATE_PENDING')), 'e', noSleep, -1)
    ).rejects.toThrow('timed out');
  });
});

describe('slices', () => {
  it('covers the whole window in half-open slices ending one second past the last block', () => {
    expect(timestampLiteral(1704067200)).toBe('2024-01-01 00:00:00');
    expect(slices(1704067200, 1704067200 + 100 * 86_400, 90 * 86_400)).toEqual([
      {fromTime: '2024-01-01 00:00:00', toTime: '2024-03-31 00:00:00'},
      {fromTime: '2024-03-31 00:00:00', toTime: '2024-04-10 00:00:01'},
    ]);
    expect(slices(1704067200, 1704067200)).toEqual([
      {fromTime: '2024-01-01 00:00:00', toTime: '2024-01-01 00:00:01'},
    ]);
  });
});

describe('querySlice', () => {
  it('halves a slice that times out and keeps rows in window order', async () => {
    const seen: string[] = [];
    const dune: DuneClient = {
      execute: async (sql) => {
        seen.push(sql);
        return `e${seen.length}`;
      },
      state: async (id) => {
        const sql = seen[Number(id.slice(1)) - 1];
        return sql.includes('WIDE')
          ? {state: 'QUERY_STATE_FAILED', error: 'Query execution timed out'}
          : {state: 'QUERY_STATE_COMPLETED'};
      },
      rows: async (id) => [{block_number: Number(id.slice(1))}],
    };
    const render = (s: {fromTime: string; toTime: string}) =>
      Date.parse(`${s.toTime}Z`) - Date.parse(`${s.fromTime}Z`) > 2 * 86_400_000
        ? `WIDE ${s.fromTime}`
        : `ok ${s.fromTime}`;
    const out = await querySlice(
      dune,
      async () => {},
      render,
      {fromTime: '2024-01-01 00:00:00', toTime: '2024-01-05 00:00:00'},
      () => {}
    );
    expect(out.executions.map((e) => [e.fromTime, e.toTime])).toEqual([
      ['2024-01-01 00:00:00', '2024-01-03 00:00:00'],
      ['2024-01-03 00:00:00', '2024-01-05 00:00:00'],
    ]);
    expect(out.rows.map((r) => r.block_number)).toEqual([2, 3]);
  });

  it('does not retry other failures or slices under one hour', async () => {
    const failing: DuneClient = {
      execute: async () => 'e',
      state: async () => ({state: 'QUERY_STATE_FAILED', error: 'syntax error'}),
      rows: async () => [],
    };
    await expect(
      querySlice(
        failing,
        async () => {},
        () => 'x',
        {fromTime: '2024-01-01 00:00:00', toTime: '2024-01-02 00:00:00'},
        () => {}
      )
    ).rejects.toThrow('syntax error');
    const timing: DuneClient = {
      ...failing,
      state: async () => ({state: 'QUERY_STATE_FAILED', error: 'timed out'}),
    };
    await expect(
      querySlice(
        timing,
        async () => {},
        () => 'x',
        {fromTime: '2024-01-01 00:00:00', toTime: '2024-01-01 00:30:00'},
        () => {}
      )
    ).rejects.toThrow('timed out');
  });
});

describe('buildSurplus', () => {
  const inputs = {
    inventory: {
      addressBook: {repository: 'x', commit: 'y', tag: 'z'},
      targets: [
        {
          chainId: 1,
          chainAlias: 'mainnet',
          market: 'AaveV3Ethereum',
          executor: POOL,
          aclAdmin: POOL,
          aclManager: POOL,
          oracle: POOL,
          governedByDao: true,
          targetType: 'pool' as const,
          target: POOL,
          source: 's',
        },
      ],
    },
    inventoryText: 'i',
    run: {
      pinnedAt: 'p',
      inventorySha256: 'i',
      permissionsBook: {commit: 'c'},
      chains: [
        {
          chainId: 1,
          alias: 'mainnet',
          fromBlock: 10,
          fromBlockSource: 'permissions-book' as const,
          toBlock: 20,
          toBlockTimestamp: 1704067200 + 200 * 86_400,
          markets: [],
        },
      ],
      failures: [],
      exclusions: [],
    },
    runText: 'r',
    balances: {runSha256: 'r', inventorySha256: 'i', chains: [], failures: []},
    balancesText: 'b',
    filtered: {
      balancesSha256: 'b',
      minUsd: 1000,
      chains: [
        {
          chainId: 1,
          alias: 'mainnet',
          block: 20,
          holdings: [
            {
              chainId: 1,
              chainAlias: 'mainnet',
              market: 'AaveV3Ethereum',
              kind: 'underlying-in-own-atoken' as const,
              holder: AUSDC,
              holderSymbol: 'aUSDC',
              token: USDC,
              tokenSymbol: 'USDC',
              decimals: 6,
              amount: '5',
              amountFormatted: '0.000005',
            },
            {
              chainId: 1,
              chainAlias: 'mainnet',
              market: 'AaveV3Ethereum',
              kind: 'atoken-in-itself' as const,
              holder: AUSDC,
              holderSymbol: 'aUSDC',
              token: AUSDC,
              tokenSymbol: 'aUSDC',
              decimals: 6,
              amount: '5',
              amountFormatted: '0.000005',
            },
          ],
        },
      ],
      unpriced: [],
      totalUsd: '0.00',
    },
    filteredText: 'f',
  } as unknown as PipelineInputs;

  it('queries only surplus holdings and records execution id, rows and hashes', async () => {
    const sent: string[] = [];
    const dune: DuneClient = {
      execute: async (sql) => (sent.push(sql), `exec-${sent.length}`),
      state: async () => ({state: 'QUERY_STATE_COMPLETED'}),
      rows: async (id) => [
        {
          block_number: 15,
          tx_hash: TX(1),
          index: Number(id.slice(5)),
          from_topic: `0x${'0'.repeat(24)}${ALICE.slice(2)}`,
          amount: '0x05',
          tx_from: ALICE,
          tx_to: USDC,
        },
      ],
    };
    const out = await buildSurplus(
      inputs,
      template,
      dune,
      async () => 1704067200,
      async () => {}
    );
    expect(sent).toHaveLength(2);
    expect(sent[0]).toContain('BETWEEN 10 AND 20');
    expect(sent[1]).toContain("TIMESTAMP '2024-06-29 00:00:00'");
    const row = (logIndex: number) => ({
      block: 15,
      txHash: TX(1),
      logIndex,
      tokenFrom: ALICE,
      amount: '5',
      txFrom: ALICE,
      txTo: USDC,
    });
    expect(out).toEqual({
      filteredSha256: sha256('f'),
      sqlSha256: sha256(template),
      holdings: [
        {
          chainId: 1,
          chainAlias: 'mainnet',
          market: 'AaveV3Ethereum',
          holder: AUSDC,
          token: USDC,
          fromBlock: 10,
          toBlock: 20,
          executions: [
            {id: 'exec-1', fromTime: '2024-01-01 00:00:00', toTime: '2024-06-29 00:00:00'},
            {id: 'exec-2', fromTime: '2024-06-29 00:00:00', toTime: '2024-07-19 00:00:01'},
          ],
          rows: [row(1), row(2)],
        },
      ],
      failures: [],
    });
    expect(canonicalJson(out)).toBe(canonicalJson(JSON.parse(canonicalJson(out))));
  });

  it('reuses completed holdings of a previous run over the same inputs and SQL, retries failures', async () => {
    const executed: string[] = [];
    const dune: DuneClient = {
      execute: async (sql) => (executed.push(sql), 'exec-new'),
      state: async () => ({state: 'QUERY_STATE_COMPLETED'}),
      rows: async () => [],
    };
    const done = {
      chainId: 1,
      chainAlias: 'mainnet',
      market: 'AaveV3Ethereum',
      holder: AUSDC,
      token: USDC,
      fromBlock: 10,
      toBlock: 20,
      executions: [{id: 'exec-old', fromTime: 'a', toTime: 'b'}],
      rows: [],
    };
    const previous = {
      filteredSha256: sha256('f'),
      sqlSha256: sha256(template),
      holdings: [done],
      failures: [],
    };
    const reused = await buildSurplus(
      inputs,
      template,
      dune,
      async () => 1704067200,
      async () => {},
      () => {},
      previous
    );
    expect(executed).toEqual([]);
    expect(reused.holdings).toEqual([done]);
    const other = await buildSurplus(
      inputs,
      template,
      dune,
      async () => 1704067200,
      async () => {},
      () => {},
      {...previous, sqlSha256: 'x'}
    );
    expect(executed).toHaveLength(2);
    expect(other.holdings[0].executions.map((e) => e.id)).toEqual(['exec-new', 'exec-new']);
  });

  it('records a failure per holding instead of aborting', async () => {
    const dune: DuneClient = {
      execute: async () => {
        throw new Error('Dune POST /sql/execute: HTTP 402');
      },
      state: async () => ({state: 'QUERY_STATE_COMPLETED'}),
      rows: async () => [],
    };
    const out = await buildSurplus(
      inputs,
      template,
      dune,
      async () => 1704067200,
      async () => {}
    );
    expect(out.holdings).toEqual([]);
    expect(out.failures).toEqual([
      {
        chainId: 1,
        alias: 'mainnet',
        holder: AUSDC,
        token: USDC,
        reason: 'Dune POST /sql/execute: HTTP 402',
      },
    ]);
  });
});

describe('duneClient', () => {
  it('waits and retries on 429, then gives up', async () => {
    const statuses = [429, 429, 200];
    const waits: number[] = [];
    const fetchImpl = (async () => {
      const status = statuses.shift()!;
      return new Response(status === 200 ? JSON.stringify({execution_id: 'e'}) : 'slow down', {
        status,
        headers: status === 429 ? {'retry-after': '2'} : {},
      });
    }) as unknown as typeof fetch;
    const client = duneClient('k', fetchImpl, async (ms) => void waits.push(ms));
    expect(await client.execute('select 1')).toBe('e');
    expect(waits).toEqual([2000, 2000]);
    const always429 = (async () => new Response('x', {status: 429})) as unknown as typeof fetch;
    await expect(duneClient('k', always429, async () => {}).execute('select 1')).rejects.toThrow(
      'HTTP 429'
    );
  });
});

describe('retryAfterMs', () => {
  it('reads seconds, HTTP dates, and falls back to 15 s', () => {
    expect(retryAfterMs('2')).toBe(2000);
    expect(retryAfterMs(null)).toBe(15_000);
    expect(retryAfterMs('garbage')).toBe(15_000);
    expect(
      retryAfterMs('Wed, 21 Oct 2026 07:28:00 GMT', Date.parse('Wed, 21 Oct 2026 07:27:30 GMT'))
    ).toBe(30_000);
  });
});
