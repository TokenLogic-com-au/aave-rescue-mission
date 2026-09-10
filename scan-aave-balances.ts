/**
 * Standalone Aave V3 Balance & Surplus Scanner (Viem)
 *
 * Checks:
 *   a) aToken balance of own underlying minus virtual balance (surplus / deficit)
 *   b) Each Aave-supported token (underlyings and aTokens) balance in:
 *      - Pool (should be 0)
 *      - All aTokens (foreign underlyings, other aTokens, self-holding; should be 0)
 *
 * Features:
 *   - Aggregates totals by value per network and per market (Rescueable Surplus, Deficits, Net).
 *   - Uses Alchemy RPC with fallback to custom RPC_<CHAIN> env vars.
 *   - Oracle price caching: queries AaveOracle at the scanned block, caches prices & calculates USD values.
 *   - Idempotent block pinning: pins the current block in a JSON cache file so repeat scans are 100% deterministic.
 *   - Clean, readable console summary + detailed JSON output.
 *
 * Usage:
 *   npx tsx scan-aave-balances.ts --chain polygon
 *   npx tsx scan-aave-balances.ts --chain mainnet
 *   npx tsx scan-aave-balances.ts --all
 *   npx tsx scan-aave-balances.ts --summary                  # print cached totals without RPC calls
 *   npx tsx scan-aave-balances.ts --chain arbitrum --repin   # force re-pin to latest block
 */

import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import {
  createPublicClient,
  erc20Abi,
  formatUnits,
  http,
  parseAbi,
  type Address,
  type MulticallParameters,
} from 'viem';

// Load environment variables (.env)
dotenv.config();

// ============================================================================
// Types
// ============================================================================

export type FindingKind =
  | 'underlying-surplus' // (a) aToken holding own underlying above virtual balance
  | 'token-in-pool' // (b) Pool contract holding underlying or aToken
  | 'foreign-token-in-atoken' // (b) aToken holding a foreign underlying or another aToken
  | 'atoken-in-itself'; // (b) aToken holding its own token address

export type Finding = {
  chainId: number;
  chainAlias: string;
  market: string;
  kind: FindingKind;
  holder: Address;
  holderSymbol: string;
  token: Address;
  tokenSymbol: string;
  decimals: number;
  amount: string; // Raw base units
  amountFormatted: string; // Decimal-adjusted string
  virtualBalance?: string; // For underlying-surplus
  priceUsd?: string; // Aave Oracle unit-formatted price
  valueUsd?: string; // Calculated USD value (floored to cents)
  note?: string;
};

export type CachedOraclePrice = {
  symbol: string;
  priceRaw: string;
  priceUsd: string;
};

export type MarketSummary = {
  findingsCount: number;
  surplusValueUsd: string; // Positive / rescueable value
  deficitValueUsd: string; // Negative balance below virtual balance
  netValueUsd: string; // surplus - deficit
  byKind: Record<string, {count: number; totalValueUsd: string}>;
};

export type ChainScanResult = {
  chainId: number;
  alias: string;
  pinnedBlock: number;
  pinnedAt: string;
  oracleBaseUnit: string;
  oraclePrices: Record<string, CachedOraclePrice>;
  stats: {
    marketsScanned: number;
    tokensScanned: number;
    checksPerformed: number;
    findingsCount: number;
    surplusValueUsd: string;
    deficitValueUsd: string;
    netValueUsd: string;
    byMarket: Record<string, MarketSummary>;
  };
  findings: Finding[];
};

export type ScanCache = {
  version: string;
  chains: Record<string, ChainScanResult>;
};

// ============================================================================
// Chain & RPC Configuration
// ============================================================================

export type ChainConfig = {
  chainId: number;
  alias: string;
  alchemy: string;
};

export const CHAINS: readonly ChainConfig[] = [
  {chainId: 1, alias: 'mainnet', alchemy: 'eth-mainnet'},
  {chainId: 10, alias: 'optimism', alchemy: 'opt-mainnet'},
  {chainId: 56, alias: 'bnb', alchemy: 'bnb-mainnet'},
  {chainId: 100, alias: 'gnosis', alchemy: 'gnosis-mainnet'},
  {chainId: 137, alias: 'polygon', alchemy: 'polygon-mainnet'},
  {chainId: 143, alias: 'monad', alchemy: 'monad-mainnet'},
  {chainId: 146, alias: 'sonic', alchemy: 'sonic-mainnet'},
  {chainId: 196, alias: 'xlayer', alchemy: 'xlayer-mainnet'},
  {chainId: 324, alias: 'zksync', alchemy: 'zksync-mainnet'},
  {chainId: 1088, alias: 'metis', alchemy: 'metis-mainnet'},
  {chainId: 1868, alias: 'soneium', alchemy: 'soneium-mainnet'},
  {chainId: 4326, alias: 'megaeth', alchemy: 'megaeth-mainnet'},
  {chainId: 5000, alias: 'mantle', alchemy: 'mantle-mainnet'},
  {chainId: 8453, alias: 'base', alchemy: 'base-mainnet'},
  {chainId: 9745, alias: 'plasma', alchemy: 'plasma-mainnet'},
  {chainId: 42161, alias: 'arbitrum', alchemy: 'arb-mainnet'},
  {chainId: 42220, alias: 'celo', alchemy: 'celo-mainnet'},
  {chainId: 43114, alias: 'avalanche', alchemy: 'avax-mainnet'},
  {chainId: 57073, alias: 'ink', alchemy: 'ink-mainnet'},
  {chainId: 59144, alias: 'linea', alchemy: 'linea-mainnet'},
  {chainId: 534352, alias: 'scroll', alchemy: 'scroll-mainnet'},
];

/** Standard Multicall3 contract address across EVM networks */
const MULTICALL3_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11';
const ZKSYNC_MULTICALL3 = '0xF9cda624FBC7e059355ce98a31693d299FACd963';

function getMulticallAddress(chainId: number): Address {
  return chainId === 324 ? ZKSYNC_MULTICALL3 : MULTICALL3_ADDRESS;
}

function getRpcUrl(chain: ChainConfig): string {
  const envRpc = process.env[`RPC_${chain.alias.toUpperCase()}`];
  if (envRpc) return envRpc;

  const key = process.env.ALCHEMY_API_KEY;
  if (!key) {
    throw new Error(
      `No RPC configured for ${chain.alias}. Set RPC_${chain.alias.toUpperCase()} or ALCHEMY_API_KEY in .env`
    );
  }
  return `https://${chain.alchemy}.g.alchemy.com/v2/${key}`;
}

// ============================================================================
// ABIs
// ============================================================================

const POOL_ABI = parseAbi([
  'function getVirtualUnderlyingBalance(address asset) view returns (uint128)',
]);

const ORACLE_ABI = parseAbi([
  'function BASE_CURRENCY_UNIT() view returns (uint256)',
  'function getAssetPrice(address asset) view returns (uint256)',
]);

// ============================================================================
// USD Arithmetic Helpers (Pure integer cents to prevent floating errors)
// ============================================================================

function parseCents(usd: string | undefined): bigint {
  if (!usd) return 0n;
  const isNeg = usd.startsWith('-');
  const [whole, frac = ''] = usd.replace('-', '').split('.');
  const cents = BigInt(whole) * 100n + BigInt(frac.padEnd(2, '0').slice(0, 2));
  return isNeg ? -cents : cents;
}

function formatCents(cents: bigint): string {
  const sign = cents < 0n ? '-' : '';
  const abs = cents < 0n ? -cents : cents;
  return `${sign}${abs / 100n}.${(abs % 100n).toString().padStart(2, '0')}`;
}

function calculateUsdValue(amount: bigint, decimals: number, price: bigint, unit: bigint): string {
  if (unit === 0n) return '0.00';
  const cents = (amount * price * 100n) / (10n ** BigInt(decimals) * unit);
  return formatCents(cents);
}

function sumCents(values: (string | undefined)[]): {
  posCents: bigint;
  negCents: bigint;
  netCents: bigint;
} {
  let posCents = 0n;
  let negCents = 0n;
  for (const v of values) {
    const c = parseCents(v);
    if (c > 0n) posCents += c;
    else if (c < 0n) negCents += -c;
  }
  return {posCents, negCents, netCents: posCents - negCents};
}

// ============================================================================
// Inventory & Cache Loaders
// ============================================================================

type TargetRow = {
  chainId: number;
  chainAlias: string;
  market: string;
  targetType: 'pool' | 'aToken';
  target: Address;
  oracle: Address;
  underlying?: Address;
  symbol?: string;
  decimals?: number;
  governedByDao?: boolean;
};

function loadInventory(): TargetRow[] {
  const possiblePaths = [
    process.env.INVENTORY_PATH,
    path.resolve(__dirname, 'js-scripts/phase4/data/inventory.json'),
    path.resolve(__dirname, 'data/inventory.json'),
  ].filter(Boolean) as string[];

  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      const data = JSON.parse(fs.readFileSync(p, 'utf8'));
      return data.targets || data;
    }
  }
  throw new Error(
    `Inventory file not found in: ${possiblePaths.join(', ')}. Run phase4:inventory first or set INVENTORY_PATH.`
  );
}

function loadCache(cacheFile: string): ScanCache {
  if (fs.existsSync(cacheFile)) {
    try {
      return JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    } catch {
      console.warn(`Warning: Could not parse ${cacheFile}, creating new cache.`);
    }
  }
  return {version: '1.0.0', chains: {}};
}

function saveCache(cacheFile: string, cache: ScanCache): void {
  const dir = path.dirname(cacheFile);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, {recursive: true});
  fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 2) + '\n');

  // Also sync to docs/data/balances-cache.json for GitHub Pages
  const docsData = path.resolve(__dirname, 'docs/data/balances-cache.json');
  const docsDir = path.dirname(docsData);
  if (fs.existsSync(path.resolve(__dirname, 'docs'))) {
    if (!fs.existsSync(docsDir)) fs.mkdirSync(docsDir, {recursive: true});
    fs.writeFileSync(docsData, JSON.stringify(cache, null, 2) + '\n');
  }
}

// ============================================================================
// Multicall Batch Executor
// ============================================================================

const CHUNK_SIZE = 250;

type MulticallItem = {
  address: Address;
  abi: readonly unknown[];
  functionName: string;
  args?: readonly unknown[];
};

async function executeMulticall(
  client: ReturnType<typeof createPublicClient>,
  chainId: number,
  calls: MulticallItem[],
  blockNumber: bigint
): Promise<(bigint | undefined)[]> {
  const multicallAddress = getMulticallAddress(chainId);
  const results: (bigint | undefined)[] = [];

  for (let i = 0; i < calls.length; i += CHUNK_SIZE) {
    const chunk = calls.slice(i, i + CHUNK_SIZE);
    const res = await client.multicall({
      contracts: chunk as MulticallParameters['contracts'],
      multicallAddress,
      blockNumber,
      allowFailure: true,
    });
    for (const r of res) {
      results.push(
        r.status === 'success' && r.result !== undefined ? BigInt(r.result as bigint) : undefined
      );
    }
  }
  return results;
}

// ============================================================================
// Core Scanning Logic
// ============================================================================

type MarketDefinition = {
  market: string;
  pool: Address;
  oracle: Address;
  reserves: {
    underlying: Address;
    aToken: Address;
    symbol: string;
    decimals: number;
  }[];
};

export async function scanChain(
  chain: ChainConfig,
  targets: TargetRow[],
  cache: ScanCache,
  options: {repin?: boolean} = {}
): Promise<ChainScanResult> {
  const chainTargets = targets.filter(
    (t) => t.chainId === chain.chainId && t.governedByDao !== false
  );
  if (chainTargets.length === 0) {
    throw new Error(`No targets found in inventory for ${chain.alias} (${chain.chainId})`);
  }

  // Group by market
  const marketsMap = new Map<string, MarketDefinition>();
  const marketNames = [...new Set(chainTargets.map((t) => t.market))];

  for (const name of marketNames) {
    const poolTarget = chainTargets.find((t) => t.market === name && t.targetType === 'pool');
    if (!poolTarget) continue;
    const aTokenTargets = chainTargets.filter(
      (t) => t.market === name && t.targetType === 'aToken'
    );

    marketsMap.set(name, {
      market: name,
      pool: poolTarget.target,
      oracle: poolTarget.oracle,
      reserves: aTokenTargets.map((a) => ({
        underlying: a.underlying!,
        aToken: a.target,
        symbol: a.symbol!,
        decimals: a.decimals!,
      })),
    });
  }

  const rpcUrl = getRpcUrl(chain);
  const multicallAddress = getMulticallAddress(chain.chainId);

  const chainDef = {
    id: chain.chainId,
    name: chain.alias,
    nativeCurrency: {name: 'Ether', symbol: 'ETH', decimals: 18},
    rpcUrls: {default: {http: [rpcUrl]}},
    contracts: {
      multicall3: {
        address: multicallAddress,
      },
    },
  };

  const client = createPublicClient({
    chain: chainDef as any,
    transport: http(rpcUrl, {
      batch: false,
      timeout: 60_000,
      retryCount: 3,
      retryDelay: 1_000,
    }),
    batch: {
      multicall: true,
    },
  });

  // Determine block number: use pinned block from cache for idempotency, or fetch current
  const cachedChain = cache.chains[chain.alias];
  let pinnedBlock: number;
  let pinnedAt: string;

  if (cachedChain?.pinnedBlock && !options.repin) {
    pinnedBlock = cachedChain.pinnedBlock;
    pinnedAt = cachedChain.pinnedAt;
    console.log(`Using idempotent pinned block ${pinnedBlock} (pinned: ${pinnedAt})`);
  } else {
    const current = await client.getBlockNumber();
    pinnedBlock = Number(current);
    pinnedAt = new Date().toISOString();
    console.log(`Pinning fresh block: ${pinnedBlock} at ${pinnedAt}`);
  }

  const block = BigInt(pinnedBlock);
  const findings: Finding[] = [];
  const cachedPrices: Record<string, CachedOraclePrice> = {};
  let oracleBaseUnit = '100000000';
  let totalChecks = 0;

  for (const [marketName, def] of marketsMap.entries()) {
    console.log(`  Scanning ${marketName} (${def.reserves.length} reserves)...`);

    // 1. Fetch Oracle base unit and asset prices for all underlying assets
    const oracleCalls: MulticallItem[] = [
      {address: def.oracle, abi: ORACLE_ABI, functionName: 'BASE_CURRENCY_UNIT', args: []},
      ...def.reserves.map((r) => ({
        address: def.oracle,
        abi: ORACLE_ABI,
        functionName: 'getAssetPrice',
        args: [r.underlying],
      })),
    ];

    const oracleResults = await executeMulticall(client, chain.chainId, oracleCalls, block);
    const rawUnit = oracleResults[0] ?? 100_000_000n;
    oracleBaseUnit = rawUnit.toString();
    const unitDecimals = rawUnit.toString().length - 1;

    const priceMap = new Map<string, bigint>();
    def.reserves.forEach((r, idx) => {
      const price = oracleResults[idx + 1];
      if (price !== undefined) {
        priceMap.set(r.underlying.toLowerCase(), price);
        const priceUsd = formatUnits(price, unitDecimals);
        cachedPrices[r.underlying.toLowerCase()] = {
          symbol: r.symbol,
          priceRaw: price.toString(),
          priceUsd,
        };
      }
    });

    // 2. Fetch Pool's virtual underlying balances for check (a)
    const virtualCalls: MulticallItem[] = def.reserves.map((r) => ({
      address: def.pool,
      abi: POOL_ABI,
      functionName: 'getVirtualUnderlyingBalance',
      args: [r.underlying],
    }));

    const virtualResults = await executeMulticall(client, chain.chainId, virtualCalls, block);
    const virtualMap = new Map<string, bigint>();
    def.reserves.forEach((r, idx) => {
      virtualMap.set(r.underlying.toLowerCase(), virtualResults[idx] ?? 0n);
    });

    // 3. Supported market tokens: all underlyings and all aTokens
    const marketTokens = def.reserves.flatMap((r) => [
      {
        address: r.underlying,
        symbol: r.symbol,
        decimals: r.decimals,
        underlying: r.underlying,
        isAToken: false,
      },
      {
        address: r.aToken,
        symbol: `a${r.symbol}`,
        decimals: r.decimals,
        underlying: r.underlying,
        isAToken: true,
      },
    ]);

    // Holders: all aTokens + the Pool
    const holders = [
      ...def.reserves.map((r) => ({
        address: r.aToken,
        symbol: `a${r.symbol}`,
        ownUnderlying: r.underlying,
        isPool: false,
      })),
      {address: def.pool, symbol: 'Pool', ownUnderlying: undefined, isPool: true},
    ];

    // Build Cartesian pairs (holder x token)
    type CheckPair = {
      holder: (typeof holders)[0];
      token: (typeof marketTokens)[0];
    };

    const pairs: CheckPair[] = [];
    for (const h of holders) {
      for (const t of marketTokens) {
        pairs.push({holder: h, token: t});
      }
    }
    totalChecks += pairs.length;

    // 4. Batch query balanceOf for all pairs
    const balanceCalls: MulticallItem[] = pairs.map((p) => ({
      address: p.token.address,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [p.holder.address],
    }));

    const balanceResults = await executeMulticall(client, chain.chainId, balanceCalls, block);

    // 5. Evaluate findings
    pairs.forEach((p, idx) => {
      const balance = balanceResults[idx] ?? 0n;
      let effectiveAmount = balance;
      let kind: FindingKind;
      let virtualBalanceStr: string | undefined;
      let note: string | undefined;

      const isOwnUnderlying =
        !p.holder.isPool &&
        p.holder.ownUnderlying &&
        p.token.address.toLowerCase() === p.holder.ownUnderlying.toLowerCase();

      if (isOwnUnderlying) {
        // --- Check a): Underlying surplus (balance of underlying - virtual balance) ---
        kind = 'underlying-surplus';
        const virtual = virtualMap.get(p.token.address.toLowerCase()) ?? 0n;
        virtualBalanceStr = virtual.toString();
        effectiveAmount = balance - virtual;

        if (virtual === 0n && balance > 0n) {
          note = 'virtual balance is zero: reserve may not use virtual accounting';
        } else if (effectiveAmount < 0n) {
          note = 'balance below virtual balance (deficit)';
        }
      } else if (p.holder.isPool) {
        // --- Check b.1): Supported token held in Pool (legitimately holds 0) ---
        kind = 'token-in-pool';
      } else if (p.token.address.toLowerCase() === p.holder.address.toLowerCase()) {
        // --- Check b.2): aToken holding itself ---
        kind = 'atoken-in-itself';
      } else {
        // --- Check b.3): Foreign underlying or foreign aToken held in an aToken ---
        kind = 'foreign-token-in-atoken';
      }

      // Record any non-zero finding (surplus or stuck tokens)
      if (effectiveAmount !== 0n) {
        const price = priceMap.get(p.token.underlying.toLowerCase());
        const priceUsd = price !== undefined ? formatUnits(price, unitDecimals) : undefined;
        const valueUsd =
          price !== undefined
            ? calculateUsdValue(effectiveAmount, p.token.decimals, price, rawUnit)
            : undefined;

        findings.push({
          chainId: chain.chainId,
          chainAlias: chain.alias,
          market: marketName,
          kind,
          holder: p.holder.address,
          holderSymbol: p.holder.symbol,
          token: p.token.address,
          tokenSymbol: p.token.symbol,
          decimals: p.token.decimals,
          amount: effectiveAmount.toString(),
          amountFormatted: formatUnits(effectiveAmount, p.token.decimals),
          ...(virtualBalanceStr !== undefined ? {virtualBalance: virtualBalanceStr} : {}),
          ...(priceUsd !== undefined ? {priceUsd} : {}),
          ...(valueUsd !== undefined ? {valueUsd} : {}),
          ...(note ? {note} : {}),
        });
      }
    });
  }

  // Sort findings for determinism: by market, then kind, then token symbol
  findings.sort(
    (a, b) =>
      a.market.localeCompare(b.market) ||
      a.kind.localeCompare(b.kind) ||
      a.tokenSymbol.localeCompare(b.tokenSymbol)
  );

  // Compute breakdown by market
  const byMarket: Record<string, MarketSummary> = {};
  for (const market of marketNames) {
    const marketFindings = findings.filter((f) => f.market === market);
    const byKind: Record<string, {count: number; totalValueUsd: string}> = {};

    for (const kind of [
      'underlying-surplus',
      'token-in-pool',
      'foreign-token-in-atoken',
      'atoken-in-itself',
    ] as FindingKind[]) {
      const kf = marketFindings.filter((f) => f.kind === kind);
      const kSums = sumCents(kf.map((f) => f.valueUsd));
      byKind[kind] = {
        count: kf.length,
        totalValueUsd: formatCents(kSums.netCents),
      };
    }

    const sums = sumCents(marketFindings.map((f) => f.valueUsd));
    byMarket[market] = {
      findingsCount: marketFindings.length,
      surplusValueUsd: formatCents(sums.posCents),
      deficitValueUsd: formatCents(sums.negCents),
      netValueUsd: formatCents(sums.netCents),
      byKind,
    };
  }

  const chainSums = sumCents(findings.map((f) => f.valueUsd));

  return {
    chainId: chain.chainId,
    alias: chain.alias,
    pinnedBlock,
    pinnedAt,
    oracleBaseUnit,
    oraclePrices: cachedPrices,
    stats: {
      marketsScanned: marketsMap.size,
      tokensScanned: Object.keys(cachedPrices).length,
      checksPerformed: totalChecks,
      findingsCount: findings.length,
      surplusValueUsd: formatCents(chainSums.posCents),
      deficitValueUsd: formatCents(chainSums.negCents),
      netValueUsd: formatCents(chainSums.netCents),
      byMarket,
    },
    findings,
  };
}

// ============================================================================
// CLI Entry Point & Pretty Printing
// ============================================================================

const pad = (str: string, len: number, right = false) =>
  right ? str.padStart(len) : str.length > len ? str.slice(0, len - 3) + '...' : str.padEnd(len);

function printFindingsTable(result: ChainScanResult): void {
  console.log(`\n=== Results for ${result.alias} (Chain ${result.chainId}) ===`);
  console.log(`Block: ${result.pinnedBlock} (Pinned at: ${result.pinnedAt})`);
  console.log(
    `Checks: ${result.stats.checksPerformed} across ${result.stats.marketsScanned} market(s)`
  );
  console.log(
    `Findings: ${result.stats.findingsCount} items | Rescueable: $${result.stats.surplusValueUsd} | Net Total: $${result.stats.netValueUsd}\n`
  );

  if (result.findings.length === 0) {
    console.log('  No stuck tokens or underlying surplus found.');
    return;
  }

  console.log(
    pad('Kind', 24) +
      pad('Market', 22) +
      pad('Holder', 12) +
      pad('Token', 10) +
      pad('Amount', 20) +
      pad('Price USD', 12) +
      'Value USD'
  );
  console.log('-'.repeat(110));

  for (const f of result.findings) {
    console.log(
      pad(f.kind, 24) +
        pad(f.market, 22) +
        pad(f.holderSymbol, 12) +
        pad(f.tokenSymbol, 10) +
        pad(f.amountFormatted, 20) +
        pad(f.priceUsd ? `$${f.priceUsd}` : 'N/A', 12) +
        (f.valueUsd ? `$${f.valueUsd}` : 'N/A')
    );
  }

  // Market Breakdown Table for this Network
  console.log(`\n--- Totals by Market (${result.alias}) ---`);
  console.log(
    pad('Market', 28) +
      pad('Findings', 10, true) +
      pad('Rescueable (USD)', 18, true) +
      pad('Deficit (USD)', 16, true) +
      pad('Net Total (USD)', 18, true)
  );
  console.log('-'.repeat(90));

  for (const [mName, mStats] of Object.entries(result.stats.byMarket)) {
    console.log(
      pad(mName, 28) +
        pad(String(mStats.findingsCount), 10, true) +
        pad(`$${mStats.surplusValueUsd}`, 18, true) +
        pad(mStats.deficitValueUsd !== '0.00' ? `-$${mStats.deficitValueUsd}` : '$0.00', 16, true) +
        pad(`$${mStats.netValueUsd}`, 18, true)
    );
  }
  console.log('-'.repeat(90));
  console.log(
    pad(`Total (${result.alias})`, 28) +
      pad(String(result.stats.findingsCount), 10, true) +
      pad(`$${result.stats.surplusValueUsd}`, 18, true) +
      pad(
        result.stats.deficitValueUsd !== '0.00' ? `-$${result.stats.deficitValueUsd}` : '$0.00',
        16,
        true
      ) +
      pad(`$${result.stats.netValueUsd}`, 18, true)
  );
}

export function printAggregatedTotals(cache: ScanCache): void {
  const chainAliases = Object.keys(cache.chains);
  if (chainAliases.length === 0) {
    console.log('\nNo cached scan data found.');
    return;
  }

  console.log('\n' + '='.repeat(102));
  console.log('                          AGGREGATED TOTALS BY NETWORK & MARKET');
  console.log('='.repeat(102));
  console.log(
    pad('Network', 14) +
      pad('Market', 28) +
      pad('Findings', 10, true) +
      pad('Rescueable (USD)', 18, true) +
      pad('Deficit (USD)', 15, true) +
      pad('Net Total (USD)', 17, true)
  );
  console.log('-'.repeat(102));

  let grandFindings = 0;
  let grandPosCents = 0n;
  let grandNegCents = 0n;

  for (const alias of chainAliases) {
    const chainData = cache.chains[alias];
    const marketsInFindings = [...new Set(chainData.findings.map((f) => f.market))];
    const marketEntries =
      marketsInFindings.length > 0
        ? marketsInFindings
        : Object.keys(chainData.stats.byMarket || {});

    const chainSums = sumCents(chainData.findings.map((f) => f.valueUsd));

    if (marketEntries.length === 0) {
      console.log(
        pad(alias, 14) +
          pad('(No findings)', 28) +
          pad('0', 10, true) +
          pad('$0.00', 18, true) +
          pad('$0.00', 15, true) +
          pad('$0.00', 17, true)
      );
    } else {
      let isFirst = true;
      for (const mName of marketEntries) {
        const mFindings = chainData.findings.filter((f) => f.market === mName);
        const mSums = sumCents(mFindings.map((f) => f.valueUsd));

        console.log(
          pad(isFirst ? alias : '', 14) +
            pad(mName, 28) +
            pad(String(mFindings.length), 10, true) +
            pad(`$${formatCents(mSums.posCents)}`, 18, true) +
            pad(mSums.negCents > 0n ? `-$${formatCents(mSums.negCents)}` : '$0.00', 15, true) +
            pad(`$${formatCents(mSums.netCents)}`, 17, true)
        );
        isFirst = false;
      }
      console.log(
        pad('', 14) +
          pad(`>> Subtotal (${alias})`, 28) +
          pad(String(chainData.findings.length), 10, true) +
          pad(`$${formatCents(chainSums.posCents)}`, 18, true) +
          pad(
            chainSums.negCents > 0n ? `-$${formatCents(chainSums.negCents)}` : '$0.00',
            15,
            true
          ) +
          pad(`$${formatCents(chainSums.netCents)}`, 17, true)
      );
      console.log('-'.repeat(102));
    }

    grandFindings += chainData.findings.length;
    grandPosCents += chainSums.posCents;
    grandNegCents += chainSums.negCents;
  }

  const grandNetCents = grandPosCents - grandNegCents;
  console.log(
    pad('GRAND TOTAL', 42) +
      pad(String(grandFindings), 10, true) +
      pad(`$${formatCents(grandPosCents)}`, 18, true) +
      pad(grandNegCents > 0n ? `-$${formatCents(grandNegCents)}` : '$0.00', 15, true) +
      pad(`$${formatCents(grandNetCents)}`, 17, true)
  );
  console.log('='.repeat(102) + '\n');
}

async function main() {
  const args = process.argv.slice(2);
  const chainArg = args
    .find((a, i) => args[i - 1] === '--chain' || a.startsWith('--chain='))
    ?.replace('--chain=', '');
  const isAll = args.includes('--all');
  const isSummaryOnly = args.includes('--summary');
  const isRepin = args.includes('--repin') || args.includes('--latest');
  const cacheFile =
    args
      .find((a, i) => args[i - 1] === '--cache' || a.startsWith('--cache='))
      ?.replace('--cache=', '') || path.resolve(process.cwd(), 'balances-cache.json');

  const cache = loadCache(cacheFile);

  if (isSummaryOnly) {
    printAggregatedTotals(cache);
    return;
  }

  console.log('--- Aave V3 Viem Balance & Surplus Scanner ---');
  console.log(`Cache file: ${path.relative(process.cwd(), cacheFile)}`);

  const inventory = loadInventory();

  let targetChains: ChainConfig[];
  if (chainArg) {
    const c = CHAINS.find(
      (ch) => ch.alias.toLowerCase() === chainArg.toLowerCase() || String(ch.chainId) === chainArg
    );
    if (!c) {
      console.error(
        `Unknown chain: "${chainArg}". Available: ${CHAINS.map((c) => c.alias).join(', ')}`
      );
      process.exit(1);
    }
    targetChains = [c];
  } else if (isAll) {
    targetChains = [...CHAINS];
  } else {
    console.log(
      'Note: No --chain or --all specified, defaulting to mainnet. (Use --chain <alias>, --all, or --summary)\n'
    );
    targetChains = [CHAINS.find((c) => c.alias === 'mainnet')!];
  }

  for (const chain of targetChains) {
    console.log(`\n>>> Scanning ${chain.alias} (ID: ${chain.chainId})...`);
    try {
      const result = await scanChain(chain, inventory, cache, {repin: isRepin});
      cache.chains[chain.alias] = result;
      saveCache(cacheFile, cache);
      printFindingsTable(result);
    } catch (err: any) {
      console.error(`Error scanning ${chain.alias}: ${err.message}`);
    }
  }

  console.log(`\nScan complete. Data persisted to: ${path.relative(process.cwd(), cacheFile)}`);

  if (targetChains.length > 1 || Object.keys(cache.chains).length > 1) {
    printAggregatedTotals(cache);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Fatal:', err);
    process.exit(1);
  });
}
