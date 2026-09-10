import fs from 'fs';
import path from 'path';
import {createPublicClient, getAddress, http, pad, type Address, type Hash} from 'viem';
import {Holding} from './balances';
import {sha256, writeCanonical} from './canonical';
import {assertChainId, ChainConfig, chainById, envReaders, rpcEnv} from './chains';
import {ChainFailure, chainFailure, runCli} from './cli';
import {PipelineInputs, readInputs} from './inputs';
import {poolOf} from './inventory';

/**
 * Candidate discovery for `underlying-in-own-atoken`. Underlying flows into its aToken on every
 * supply and repay, far too many transfers to scan over RPC, so a warehouse query finds the
 * transfers whose transaction emitted no Pool log. The query text lives in surplus.sql, is sent
 * to Dune as raw SQL, and its hash is recorded so the results can be tied to it. The window is
 * queried in time slices so each execution fits the plan's query timeout; a slice that times
 * out is halved. Nothing here is authoritative: attribution re-verifies every row above the
 * dust floor against its receipt.
 */
export const SURPLUS_SQL_PATH = path.resolve(__dirname, 'surplus.sql');
export const SURPLUS_PATH = path.resolve(__dirname, 'data/surplus-transfers.json');

export type SurplusRow = {
  block: number;
  txHash: Hash;
  logIndex: number;
  tokenFrom: Address;
  amount: string;
  txFrom: Address;
  txTo: Address | null;
};

export type SurplusHolding = {
  chainId: number;
  chainAlias: string;
  market: string;
  holder: Address;
  token: Address;
  fromBlock: number;
  toBlock: number;
  /** One Dune execution per time slice, in window order. */
  executions: Execution[];
  rows: SurplusRow[];
};

export type Execution = {id: string; fromTime: string; toTime: string};

export type SurplusManifest = {
  filteredSha256: string;
  sqlSha256: string;
  holdings: SurplusHolding[];
  failures: (ChainFailure & {holder: Address; token: Address})[];
};

export type DuneRow = Record<string, string | number | null>;

/** The three Dune API calls this needs. */
export type DuneClient = {
  execute(sql: string): Promise<string>;
  state(executionId: string): Promise<{state: string; error?: string}>;
  rows(executionId: string): Promise<DuneRow[]>;
};

const DUNE = 'https://api.dune.com/api/v1';

/** Rate limiting (429) is transient: wait and retry, a bounded number of times. */
const RATE_LIMIT_RETRIES = 6;

/** Retry-After as seconds or an HTTP date; 15 s when absent or unreadable. */
export function retryAfterMs(header: string | null, now = Date.now()): number {
  if (header === null) return 15_000;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds) * 1000;
  const at = Date.parse(header);
  return Number.isNaN(at) ? 15_000 : Math.max(0, at - now);
}

export function duneClient(
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))
): DuneClient {
  const call = async (method: string, route: string, body?: unknown, attempt = 0): Promise<any> => {
    const res = await fetchImpl(`${DUNE}${route}`, {
      method,
      headers: {'X-Dune-API-Key': apiKey, 'Content-Type': 'application/json'},
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 429 && attempt < RATE_LIMIT_RETRIES) {
      await res.arrayBuffer().catch(() => undefined);
      await sleep(retryAfterMs(res.headers.get('retry-after')));
      return call(method, route, body, attempt + 1);
    }
    if (!res.ok)
      throw new Error(
        `Dune ${method} ${route}: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`
      );
    return res.json();
  };
  return {
    execute: async (sql) => (await call('POST', '/sql/execute', {sql})).execution_id,
    state: async (id) => {
      const s = await call('GET', `/execution/${id}/status`);
      return {
        state: s.state,
        ...(s.error ? {error: s.error.message ?? JSON.stringify(s.error)} : {}),
      };
    },
    rows: async (id) => {
      const out: DuneRow[] = [];
      let offset: number | undefined = 0;
      while (offset !== undefined) {
        const page = await call('GET', `/execution/${id}/results?limit=10000&offset=${offset}`);
        out.push(...page.result.rows);
        offset = page.next_offset;
      }
      return out;
    },
  };
}

/** Half-open UTC time slice as Dune TIMESTAMP literals. */
export type Slice = {fromTime: string; toTime: string};

export const timestampLiteral = (unixSeconds: number): string =>
  new Date(unixSeconds * 1000)
    .toISOString()
    .replace('T', ' ')
    .replace(/\.\d{3}Z$/, '');

export function renderSql(
  template: string,
  chain: ChainConfig,
  holding: Pick<Holding, 'holder' | 'token'>,
  pool: Address,
  range: {fromBlock: number; toBlock: number},
  slice: Slice
): string {
  if (!chain.dune) throw new Error(`Dune has no logs table configured for ${chain.alias}`);
  const values: Record<string, string> = {
    chain: chain.dune,
    token: holding.token.toLowerCase(),
    holderTopic: pad(holding.holder, {size: 32}).toLowerCase(),
    pool: pool.toLowerCase(),
    fromBlock: String(range.fromBlock),
    toBlock: String(range.toBlock),
    fromTime: slice.fromTime,
    toTime: slice.toTime,
  };
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    if (!(key in values)) throw new Error(`surplus.sql uses unknown parameter ${key}`);
    return values[key];
  });
}

const hex = (v: string | number | null, what: string): string => {
  if (typeof v !== 'string' || !/^0x[0-9a-fA-F]*$/.test(v))
    throw new Error(`Dune returned a non-hex ${what}`);
  return v;
};
const addressOf = (v: string | number | null, what: string): Address =>
  getAddress(`0x${hex(v, what).slice(-40)}`);

export function parseRows(rows: DuneRow[]): SurplusRow[] {
  const keys = new Set<string>();
  for (const r of rows) {
    const key = `${r.tx_hash}:${r.index}`;
    if (keys.has(key)) throw new Error(`Dune returned ${key} twice`);
    keys.add(key);
  }
  return rows
    .map((r) => ({
      block: Number(r.block_number),
      txHash: hex(r.tx_hash, 'tx_hash') as Hash,
      logIndex: Number(r.index),
      tokenFrom: addressOf(r.from_topic, 'from_topic'),
      amount: BigInt(hex(r.amount, 'amount')).toString(),
      txFrom: addressOf(r.tx_from, 'tx_from'),
      txTo: r.tx_to === null ? null : addressOf(r.tx_to, 'tx_to'),
    }))
    .sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
}

const TERMINAL = new Set([
  'QUERY_STATE_COMPLETED',
  'QUERY_STATE_FAILED',
  'QUERY_STATE_CANCELED',
  'QUERY_STATE_EXPIRED',
  'QUERY_STATE_COMPLETED_PARTIAL',
]);

export class QueryTimeout extends Error {}

export async function awaitExecution(
  dune: DuneClient,
  executionId: string,
  sleep: (ms: number) => Promise<void>,
  timeoutMs = 20 * 60_000
): Promise<void> {
  const started = Date.now();
  for (;;) {
    const {state, error} = await dune.state(executionId);
    if (state === 'QUERY_STATE_COMPLETED') return;
    if (TERMINAL.has(state)) {
      const message = `Dune execution ${executionId} ended ${state}${error ? `: ${error}` : ''}`;
      throw /timed out/i.test(error ?? '') ? new QueryTimeout(message) : new Error(message);
    }
    if (Date.now() - started > timeoutMs)
      throw new Error(`Dune execution ${executionId} timed out in ${state}`);
    await sleep(5_000);
  }
}

const SLICE_SECONDS = 180 * 86_400;

/** Half-open slices covering [from, to], each at most SLICE_SECONDS long. */
export function slices(fromSeconds: number, toSeconds: number, length = SLICE_SECONDS): Slice[] {
  const out: Slice[] = [];
  for (let start = fromSeconds; start <= toSeconds; start += length) {
    out.push({
      fromTime: timestampLiteral(start),
      toTime: timestampLiteral(Math.min(start + length, toSeconds + 1)),
    });
  }
  return out;
}

/** Runs one slice; on a query timeout splits it in two, down to one hour. */
export async function querySlice(
  dune: DuneClient,
  sleep: (ms: number) => Promise<void>,
  render: (slice: Slice) => string,
  slice: Slice,
  log: (line: string) => void
): Promise<{executions: Execution[]; rows: DuneRow[]}> {
  const id = await dune.execute(render(slice));
  try {
    await awaitExecution(dune, id, sleep);
  } catch (error) {
    const from = Date.parse(`${slice.fromTime.replace(' ', 'T')}Z`) / 1000;
    const to = Date.parse(`${slice.toTime.replace(' ', 'T')}Z`) / 1000;
    if (!(error instanceof QueryTimeout) || to - from <= 3600) throw error;
    const mid = Math.floor((from + to) / 2);
    log(`  slice ${slice.fromTime}..${slice.toTime} timed out, splitting`);
    const a = await querySlice(
      dune,
      sleep,
      render,
      {fromTime: slice.fromTime, toTime: timestampLiteral(mid)},
      log
    );
    const b = await querySlice(
      dune,
      sleep,
      render,
      {fromTime: timestampLiteral(mid), toTime: slice.toTime},
      log
    );
    return {executions: [...a.executions, ...b.executions], rows: [...a.rows, ...b.rows]};
  }
  return {executions: [{id, ...slice}], rows: await dune.rows(id)};
}

/** Block timestamp for the time bounds; a header read only. */
export type BlockTime = (chain: ChainConfig, block: number) => Promise<number>;

function envBlockTime(env: NodeJS.ProcessEnv = process.env): BlockTime {
  const clients = envReaders(
    (url) => createPublicClient({transport: http(url, {batch: false, timeout: 60_000})}),
    env
  );
  return async (chain, block) => {
    const client = clients(chain);
    if (!client) throw new Error(`missing ${rpcEnv(chain)} or ALCHEMY_API_KEY`);
    assertChainId(await client.getChainId(), chain);
    return Number((await client.getBlock({blockNumber: BigInt(block)})).timestamp);
  };
}

export async function buildSurplus(
  inputs: PipelineInputs,
  sqlTemplate: string,
  dune: DuneClient,
  blockTime: BlockTime,
  sleep: (ms: number) => Promise<void>,
  log: (line: string) => void = () => {},
  previous?: SurplusManifest
): Promise<SurplusManifest> {
  const manifest: SurplusManifest = {
    filteredSha256: sha256(inputs.filteredText),
    sqlSha256: sha256(sqlTemplate),
    holdings: [],
    failures: [],
  };
  /** Completed holdings of an earlier run over the same inputs and SQL are reused; failures are retried. */
  const reusable =
    previous?.filteredSha256 === manifest.filteredSha256 &&
    previous.sqlSha256 === manifest.sqlSha256
      ? previous.holdings
      : [];
  const holdings = [
    ...inputs.filtered.chains.flatMap((c) => c.holdings),
    ...inputs.filtered.unpriced,
  ]
    .filter((h) => h.kind === 'underlying-in-own-atoken')
    .sort((a, b) => a.chainId - b.chainId);
  for (const h of holdings) {
    const chain = chainById(h.chainId);
    const range = inputs.run.chains.find((c) => c.chainId === h.chainId)!;
    const done = reusable.find(
      (s) =>
        s.chainId === h.chainId &&
        s.holder === h.holder &&
        s.token === h.token &&
        s.fromBlock === range.fromBlock &&
        s.toBlock === range.toBlock
    );
    if (done) {
      manifest.holdings.push(done);
      log(
        `${chain.alias} (${chain.chainId}): ${h.holderSymbol} ${h.tokenSymbol} reused from the previous run (${done.rows.length} row(s))`
      );
      continue;
    }
    try {
      const pool = poolOf(inputs.inventory, h.chainId, h.market);
      const render = (slice: Slice) => renderSql(sqlTemplate, chain, h, pool, range, slice);
      const plan = slices(await blockTime(chain, range.fromBlock), range.toBlockTimestamp);
      log(
        `${chain.alias} (${chain.chainId}): ${h.holderSymbol} surplus ${h.amountFormatted} ${h.tokenSymbol}, querying Dune ${range.fromBlock}..${range.toBlock} in ${plan.length} slice(s)...`
      );
      const executions: Execution[] = [];
      const raw: DuneRow[] = [];
      for (const slice of plan) {
        const part = await querySlice(dune, sleep, render, slice, log);
        executions.push(...part.executions);
        raw.push(...part.rows);
      }
      const rows = parseRows(raw);
      manifest.holdings.push({
        chainId: h.chainId,
        chainAlias: h.chainAlias,
        market: h.market,
        holder: h.holder,
        token: h.token,
        fromBlock: range.fromBlock,
        toBlock: range.toBlock,
        executions,
        rows,
      });
      log(
        `${chain.alias} (${chain.chainId}): ${executions.length} execution(s), ${rows.length} row(s)`
      );
    } catch (error) {
      manifest.failures.push({
        ...chainFailure(chain, error, log),
        holder: h.holder,
        token: h.token,
      });
    }
  }
  return manifest;
}

if (require.main === module)
  runCli(async () => {
    const args = process.argv.slice(2);
    if (args.some((a) => a !== '--refresh')) throw new Error('usage: surplus.ts [--refresh]');
    const refresh = args.includes('--refresh');
    const apiKey = process.env.DUNE_API_KEY;
    if (!apiKey) throw new Error('missing DUNE_API_KEY');
    const previous: SurplusManifest | undefined =
      !refresh && fs.existsSync(SURPLUS_PATH)
        ? JSON.parse(fs.readFileSync(SURPLUS_PATH, 'utf8'))
        : undefined;
    const manifest = await buildSurplus(
      readInputs(),
      fs.readFileSync(SURPLUS_SQL_PATH, 'utf8'),
      duneClient(apiKey),
      envBlockTime(),
      (ms) => new Promise((r) => setTimeout(r, ms)),
      console.log,
      previous
    );
    const digest = writeCanonical(SURPLUS_PATH, manifest);
    console.log(
      `surplus: ${manifest.holdings.length} holding(s), ${manifest.failures.length} failed, ` +
        `written ${path.relative(process.cwd(), SURPLUS_PATH)} (sha256 ${digest})`
    );
    if (manifest.failures.length) process.exitCode = 1;
  });
