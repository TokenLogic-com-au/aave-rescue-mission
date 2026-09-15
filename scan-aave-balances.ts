/**
 * Dashboard runner: the Phase 4 discovery (js-scripts/phase4) at a block per chain, written in
 * the shape docs/ reads. Blocks are pinned in the cache so repeat runs are deterministic;
 * `--repin` moves every scanned entry to the latest block. V3 entries are keyed by chain alias,
 * V4 entries by `<alias>-v4`. The pinned pipeline (`phase4:balances`) is the evidence path; this
 * is the live view over the same code.
 *
 *   npx tsx scan-aave-balances.ts --all [--repin]
 *   npx tsx scan-aave-balances.ts --chain polygon [--v4] [--cache file.json]
 *   npx tsx scan-aave-balances.ts --summary
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import {formatUnits, type Address} from 'viem';
import {chainScan, Holding, HoldingKind, HubAsset, MarketScan} from './js-scripts/phase4/balances';
import {ChainReader, envChainReaders} from './js-scripts/phase4/chain';
import {assertChainId, CHAINS, ChainConfig} from './js-scripts/phase4/chains';
import {redact} from './js-scripts/phase4/cli';
import {readVerifiedInventory} from './js-scripts/phase4/inventory';
import {formatCents, parseCents} from './js-scripts/phase4/usd';
import {Holder, Inventory} from './js-scripts/common/types';

type Finding = Omit<Holding, 'kind'> & {kind: string};
type Totals = {
  findingsCount: number;
  surplusValueUsd: string;
  deficitValueUsd: string;
  netValueUsd: string;
};
type Entry = {
  chainId: number;
  alias: string;
  pinnedBlock: number;
  pinnedAt: string;
  oracleBaseUnit: string;
  oraclePrices: Record<string, never>;
  stats: Totals & {
    marketsScanned: number;
    tokensScanned: number;
    checksPerformed: number;
    byMarket: Record<
      string,
      Totals & {byKind: Record<string, {count: number; totalValueUsd: string}>}
    >;
  };
  findings: Finding[];
};
type Cache = {version: string; chains: Record<string, Entry>};

/** Dashboard names for the discovery kinds; the surplus kinds split by sign. */
const KIND: Record<HoldingKind, string> = {
  'underlying-in-own-atoken': 'underlying-surplus',
  'atoken-in-itself': 'atoken-in-itself',
  'market-token-in-atoken': 'foreign-token-in-atoken',
  'market-token-in-pool': 'token-in-pool',
  'underlying-in-own-hub': 'v4-hub-surplus',
  'market-token-in-v4-contract': 'v4-token-in-contract',
};
const V4_HOLDER_KIND: Partial<Record<Holder['role'], string>> = {
  hub: 'v4-token-in-hub',
  spoke: 'v4-token-in-spoke',
  tokenizationSpoke: 'v4-token-in-tokenization-spoke',
  positionManager: 'v4-token-in-position-manager',
};
const V3_KINDS = [
  'underlying-surplus',
  'token-in-pool',
  'foreign-token-in-atoken',
  'atoken-in-itself',
];
const V4_KINDS = [
  'v4-hub-surplus',
  'v4-hub-deficit',
  'v4-token-in-spoke',
  'v4-token-in-tokenization-spoke',
  'v4-token-in-position-manager',
  'v4-token-in-hub',
  'v4-hub-clean',
  'v4-spoke-clean',
];

function totals(findings: Finding[]): Totals {
  let pos = 0n;
  let neg = 0n;
  for (const f of findings) {
    const c = f.valueUsd ? parseCents(f.valueUsd) : 0n;
    if (c > 0n) pos += c;
    else neg -= c;
  }
  return {
    findingsCount: findings.length,
    surplusValueUsd: formatCents(pos),
    deficitValueUsd: formatCents(neg),
    netValueUsd: formatCents(pos - neg),
  };
}

function byMarket(
  findings: Finding[],
  markets: string[],
  kinds: string[]
): Entry['stats']['byMarket'] {
  const out: Entry['stats']['byMarket'] = {};
  for (const market of markets) {
    const mine = findings.filter((f) => f.market === market);
    const byKind: Record<string, {count: number; totalValueUsd: string}> = {};
    for (const kind of kinds) {
      const k = mine.filter((f) => f.kind === kind);
      byKind[kind] = {count: k.length, totalValueUsd: totals(k).netValueUsd};
    }
    out[market] = {...totals(mine), byKind};
  }
  return out;
}

const entry = (
  chain: ChainConfig,
  alias: string,
  block: bigint,
  pinnedAt: string,
  findings: Finding[],
  markets: string[],
  kinds: string[],
  tokensScanned: number,
  checksPerformed: number
): Entry => ({
  chainId: chain.chainId,
  alias,
  pinnedBlock: Number(block),
  pinnedAt,
  oracleBaseUnit: '100000000',
  oraclePrices: {},
  stats: {
    ...totals(findings),
    marketsScanned: markets.length,
    tokensScanned,
    checksPerformed,
    byMarket: byMarket(findings, markets, kinds),
  },
  findings,
});

/** One cache entry per protocol on the chain, from a single scan. */
async function scanEntries(
  chain: ChainConfig,
  reader: ChainReader,
  inventory: Inventory,
  block: bigint,
  pinnedAt: string
): Promise<Record<string, Entry>> {
  const scan = await chainScan(chain, reader, inventory, block);
  const entries: Record<string, Entry> = {};
  const v3 = scan.markets.filter((m) => m.market.protocol === 'v3');
  const v4 = scan.markets.filter((m) => m.market.protocol === 'v4');

  const findings: Finding[] = v3
    .flatMap((m) => m.holdings)
    .map((h) => ({...h, kind: KIND[h.kind]}))
    .sort(
      (a, b) =>
        a.market.localeCompare(b.market) ||
        a.kind.localeCompare(b.kind) ||
        a.tokenSymbol.localeCompare(b.tokenSymbol)
    );
  const reserves = v3.reduce(
    (n, m) => n + m.market.tokens.filter((t) => t.pricedBy === t.address).length,
    0
  );
  entries[chain.alias] = entry(
    chain,
    chain.alias,
    block,
    pinnedAt,
    findings,
    v3.map((m) => m.market.market),
    V3_KINDS,
    reserves,
    v3.reduce((n, m) => n + m.checks, 0)
  );

  if (v4.length) {
    const rows: Finding[] = [];
    for (const m of v4) {
      const roleOf = new Map(m.market.holders.map((h) => [h.address.toLowerCase(), h.role]));
      for (const h of m.holdings) {
        const kind =
          h.kind === 'underlying-in-own-hub'
            ? BigInt(h.amount) < 0n
              ? 'v4-hub-deficit'
              : 'v4-hub-surplus'
            : V4_HOLDER_KIND[roleOf.get(h.holder.toLowerCase())!]!;
        rows.push({...h, kind});
      }
      rows.push(...cleanRows(chain, m));
    }
    rows.sort((a, b) => a.kind.localeCompare(b.kind) || a.tokenSymbol.localeCompare(b.tokenSymbol));
    const tokens = new Set(v4.flatMap((m) => m.hubAssets.map((a) => a.underlying.toLowerCase())))
      .size;
    entries[`${chain.alias}-v4`] = entry(
      chain,
      `${chain.alias}-v4`,
      block,
      pinnedAt,
      rows,
      v4.map((m) => m.market.market),
      V4_KINDS,
      tokens,
      v4.reduce((n, m) => n + m.checks, 0)
    );
  }
  return entries;
}

/** The dashboard lists what was checked and found clean, not only what was found. */
function cleanRows(chain: ChainConfig, scan: MarketScan): Finding[] {
  const {market, hubAssets, holdings} = scan;
  const dirty = new Set(holdings.map((h) => `${h.holder}:${h.token}`.toLowerCase()));
  const dirtyHolders = new Set(holdings.map((h) => h.holder.toLowerCase()));
  const base = {
    chainId: chain.chainId,
    chainAlias: chain.alias,
    market: market.market,
    amount: '0',
    amountFormatted: '0',
    valueUsd: '0.00',
  };
  const rows: Finding[] = hubAssets
    .filter((a: HubAsset) => !dirty.has(`${a.hub}:${a.underlying}`.toLowerCase()))
    .map((a) => ({
      ...base,
      kind: 'v4-hub-clean',
      holder: a.hub,
      holderSymbol: a.hubName,
      token: a.underlying,
      tokenSymbol: a.symbol,
      decimals: a.decimals,
      virtualBalance: a.liquidity.toString(),
      note: `Hub ERC20=${formatUnits(a.liquidity, a.decimals)}, liquidity=${formatUnits(a.liquidity, a.decimals)}, fees=${formatUnits(a.accruedFees, a.decimals)} (Verified Clean)`,
    }));
  const tokenCount = new Set(hubAssets.map((a) => a.underlying.toLowerCase())).size;
  for (const c of market.holders) {
    if (c.role === 'hub' || dirtyHolders.has(c.address.toLowerCase())) continue;
    rows.push({
      ...base,
      kind: 'v4-spoke-clean',
      holder: c.address,
      holderSymbol: c.name,
      token: '0x0000000000000000000000000000000000000000' as Address,
      tokenSymbol: `All Assets (${tokenCount})`,
      decimals: 18,
      note: `Verified clean: 0 stuck tokens across all ${tokenCount} scanned assets`,
    });
  }
  return rows;
}

function printTotals(cache: Cache): void {
  const rows = Object.values(cache.chains).sort((a, b) => a.alias.localeCompare(b.alias));
  for (const e of rows)
    console.log(
      `${e.alias.padEnd(14)} block ${String(e.pinnedBlock).padStart(10)}  findings ${String(e.stats.findingsCount).padStart(4)}  rescueable $${e.stats.surplusValueUsd.padStart(12)}  net $${e.stats.netValueUsd.padStart(12)}`
    );
  const all = totals(rows.flatMap((e) => e.findings));
  console.log(
    `${'total'.padEnd(14)} ${' '.repeat(17)}findings ${String(all.findingsCount).padStart(4)}  rescueable $${all.surplusValueUsd.padStart(12)}  net $${all.netValueUsd.padStart(12)}`
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const opt = (name: string) => {
    const i = args.indexOf(name);
    return i === -1 ? undefined : args[i + 1];
  };
  const cacheFile = path.resolve(opt('--cache') ?? 'balances-cache.json');
  const cache: Cache = fs.existsSync(cacheFile)
    ? JSON.parse(fs.readFileSync(cacheFile, 'utf8'))
    : {version: '1.0.0', chains: {}};
  if (args.includes('--summary')) return printTotals(cache);

  const repin = args.includes('--repin') || args.includes('--latest');
  const onlyV4 = args.includes('--v4');
  const chains = args.includes('--all')
    ? [...CHAINS]
    : [
        CHAINS.find((c) => c.alias === (opt('--chain') ?? 'mainnet')) ??
          (() => {
            throw new Error(`unknown chain ${opt('--chain')}`);
          })(),
      ];
  const {inventory} = readVerifiedInventory();
  const readers = envChainReaders();
  const save = () => fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 2) + '\n');

  for (const chain of chains) {
    const reader = readers(chain);
    const keys = [chain.alias, `${chain.alias}-v4`];
    try {
      if (!reader) throw new Error('no RPC configured');
      assertChainId(await reader.chainId(), chain);
      const previous = keys.map((k) => cache.chains[k]).find(Boolean);
      const block =
        previous && !repin ? BigInt(previous.pinnedBlock) : (await reader.latest()).number;
      const pinnedAt = previous && !repin ? previous.pinnedAt : new Date().toISOString();
      console.log(
        `${chain.alias}: scanning at block ${block}${previous && !repin ? ' (pinned)' : ''}...`
      );
      const entries = await scanEntries(chain, reader, inventory, block, pinnedAt);
      for (const [key, e] of Object.entries(entries)) {
        if (onlyV4 && !key.endsWith('-v4')) continue;
        cache.chains[key] = e;
        console.log(
          `${key}: ${e.stats.findingsCount} finding(s), rescueable $${e.stats.surplusValueUsd}`
        );
      }
      save();
    } catch (error) {
      console.error(`${chain.alias}: failed: ${redact(error)}`);
      process.exitCode = 1;
    }
  }
  printTotals(cache);
  console.log(`written ${path.relative(process.cwd(), cacheFile)}`);
}

main().catch((error: unknown) => {
  console.error(redact(error));
  process.exit(1);
});
