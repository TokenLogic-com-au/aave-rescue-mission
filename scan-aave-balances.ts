/**
 * Standalone Aave V3 + V4 Balance & Surplus Scanner (Viem)
 *
 * V3 Checks:
 *   a) aToken balance of own underlying minus virtual balance (surplus / deficit)
 *   b) Each Aave-supported token (underlyings and aTokens) balance in:
 *      - Pool (should be 0)
 *      - All aTokens (foreign underlyings, other aTokens, self-holding; should be 0)
 *
 * V4 Checks:
 *   a) Hub ERC-20 balance vs Hub accounting (getAssetLiquidity) for each Hub asset
 *   b) Any ERC-20 balances in Spokes, TokenizationSpokes, PositionManagers (should be 0)
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
 *   npx tsx scan-aave-balances.ts --chain mainnet --v4     # scan V4 Hubs/Spokes on mainnet
 *   npx tsx scan-aave-balances.ts --all
 *   npx tsx scan-aave-balances.ts --summary                  # print cached totals without RPC calls
 *   npx tsx scan-aave-balances.ts --chain arbitrum --repin   # force re-pin to latest block
 */

import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import {
  createPublicClient,
  encodeFunctionData,
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
  | 'atoken-in-itself' // (b) aToken holding its own token address
  | 'v4-hub-surplus' // V4: Hub ERC-20 balance exceeds accounting (liquidity + fees)
  | 'v4-hub-deficit' // V4: Hub ERC-20 balance below accounting
  | 'v4-token-in-spoke' // V4: Token stuck in a Spoke (should be 0)
  | 'v4-token-in-tokenization-spoke' // V4: Token stuck in a TokenizationSpoke
  | 'v4-token-in-position-manager' // V4: Token stuck in a PositionManager
  | 'v4-hub-clean' // V4: Hub ERC-20 balance matches accounting (0 diff)
  | 'v4-spoke-clean'; // V4: Spoke / PM verified clean (0 stuck tokens)

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
// V4 ABIs
// ============================================================================

const HUB_ABI = parseAbi([
  'function getAssetCount() view returns (uint256)',
  'function getAssetUnderlyingAndDecimals(uint256 assetId) view returns (address, uint8)',
  'function getAssetLiquidity(uint256 assetId) view returns (uint256)',
  'function getAssetSwept(uint256 assetId) view returns (uint256)',
  'function getAssetAccruedFees(uint256 assetId) view returns (uint256)',
]);

const SPOKE_ABI = parseAbi([
  'function getReserveCount() view returns (uint256)',
  'function ORACLE() view returns (address)',
]);

const V4_ORACLE_ABI = parseAbi([
  'function getReservePrice(uint256 reserveId) view returns (uint256)',
  'function decimals() view returns (uint8)',
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

const VIEM_BATCH_SIZE = 100_000;

type MulticallItem = {
  address: Address;
  abi: readonly unknown[];
  functionName: string;
  args?: readonly unknown[];
};

async function executeMulticall(
  client: any,
  chainId: number,
  calls: MulticallItem[],
  blockNumber: bigint
): Promise<(bigint | undefined)[]> {
  const multicallAddress = getMulticallAddress(chainId);
  const results: (bigint | undefined)[] = [];

  for (let i = 0; i < calls.length;) {
    let end = i;
    let calldataBytes = 0;

    while (end < calls.length) {
      const call = calls[end];
      const calldata = encodeFunctionData({
        abi: call.abi as any,
        functionName: call.functionName,
        args: call.args as any,
      });
      const callBytes = (calldata.length - 2) / 2;
      if (end > i && calldataBytes + callBytes > VIEM_BATCH_SIZE) break;
      calldataBytes += callBytes;
      end++;
    }

    const chunk = calls.slice(i, end);

    const res = await client.multicall({
      contracts: chunk as MulticallParameters['contracts'],
      multicallAddress,
      blockNumber,
      batchSize: VIEM_BATCH_SIZE,
      allowFailure: true,
    });
    for (const r of res) {
      results.push(
        r.status === 'success' && r.result !== undefined ? BigInt(r.result as bigint) : undefined
      );
    }

    i = end;
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
      multicall: {batchSize: VIEM_BATCH_SIZE},
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
// V4 Inventory & Scanning
// ============================================================================

export type V4ChainInventory = {
  chainId: number;
  chainAlias: string;
  market: string; // e.g. "AaveV4Ethereum"
  hubs: {name: string; address: Address}[];
  spokes: {name: string; address: Address}[];
  tokenizationSpokes: {name: string; address: Address}[];
  positionManagers: {name: string; address: Address}[];
  treasurySpoke?: Address;
};

const V4_INVENTORY: V4ChainInventory[] = [
  {
    chainId: 1,
    chainAlias: 'mainnet',
    market: 'AaveV4Ethereum',
    hubs: [
      {name: 'CORE_HUB', address: '0xCca852Bc40e560adC3b1Cc58CA5b55638ce826c9'},
      {name: 'PLUS_HUB', address: '0x06002e9c4412CB7814a791eA3666D905871E536A'},
      {name: 'PRIME_HUB', address: '0x943827DCA022D0F354a8a8c332dA1e5Eb9f9F931'},
      {name: 'GLOBAL_DOLLAR_HUB', address: '0x62d63197660c080236193CA60b70E49A08E90368'},
    ],
    spokes: [
      {name: 'MAIN_SPOKE', address: '0x94e7A5dCbE816e498b89aB752661904E2F56c485'},
      {name: 'BLUECHIP_SPOKE', address: '0x973a023A77420ba610f06b3858aD991Df6d85A08'},
      {name: 'ETHENA_CORRELATED_SPOKE', address: '0x58131E79531caB1d52301228d1f7b842F26B9649'},
      {name: 'ETHENA_ECOSYSTEM_SPOKE', address: '0xba1B3D55D249692b669A164024A838309B7508AF'},
      {name: 'FOREX_SPOKE', address: '0xD8B93635b8C6d0fF98CbE90b5988E3F2d1Cd9da1'},
      {name: 'GOLD_SPOKE', address: '0x65407b940966954b23dfA3caA5C0702bB42984DC'},
      {name: 'LOMBARD_BTC_SPOKE', address: '0x7EC68b5695e803e98a21a9A05d744F28b0a7753D'},
      {name: 'USDG_PENDLE_SPOKE', address: '0x956d8e0A89cfa3744428C4641b5a53B56167a7f9'},
      {name: 'ETHERFI_ESPOKE', address: '0xbF10BDfE177dE0336aFD7fcCF80A904E15386219'},
      {name: 'KELP_ESPOKE', address: '0x3131FE68C4722e726fe6B2819ED68e514395B9a4'},
      {name: 'LIDO_ESPOKE', address: '0xe1900480ac69f0B296841Cd01cC37546d92F35Cd'},
      {name: 'USDG_MAPLE_ESPOKE', address: '0x774b9655413c34809c1f1b16b654465A89EBE989'},
    ],
    tokenizationSpokes: [
      {name: 'CORE_WETH_TSPOKE', address: '0x7320CF22Ac095bA2a2e0a652F77efB836c2E751b'},
      {name: 'CORE_wstETH_TSPOKE', address: '0xcb0E7dA9c635628f6d4827355AeCa75aB8d3560f'},
      {name: 'CORE_weETH_TSPOKE', address: '0x559cEc2C840D9DBB18936Afc5E5341D78bfC7Cbe'},
      {name: 'CORE_rsETH_TSPOKE', address: '0x45a04Ca1A5cbEeA4B44356c75EDd29b33eB2527a'},
      {name: 'CORE_USDC_TSPOKE', address: '0x531E90a2376902DE8915789Fcc1075e3B0c153E7'},
      {name: 'CORE_USDT_TSPOKE', address: '0x5eC44a70F309854fe04d495cFE1B5dA63DD1cc73'},
      {name: 'CORE_GHO_TSPOKE', address: '0x58C14a5E061c9bC6926c5b853445290F296C2F7B'},
      {name: 'CORE_WBTC_TSPOKE', address: '0x82A9CC4656784E55Ef2E78F704028B5E1Bfc1732'},
      {name: 'CORE_cbBTC_TSPOKE', address: '0x33B41B74366F55327d959FfF6D6b6fBc2853dbB1'},
      {name: 'PLUS_USDC_TSPOKE', address: '0xc94bdd83D2c7655C280655D60954e79E88D4F949'},
      {name: 'PLUS_USDT_TSPOKE', address: '0x80835EB50694EE0e519743f67e5401e6FD300006'},
      {name: 'PLUS_GHO_TSPOKE', address: '0xA54382db40EC602c0a173A08f9E86Ed40F9D4D10'},
      {name: 'PLUS_USDe_TSPOKE', address: '0x502Cd81da6a8F1785eb2eEE72713B7388E16A854'},
      {name: 'PLUS_sUSDe_TSPOKE', address: '0x24f8c062e1E0451736C1D6E023510DA262a41df4'},
      {name: 'PRIME_WETH_TSPOKE', address: '0x2087513383330B961A3753B47627Bbf149F31c70'},
      {name: 'PRIME_USDC_TSPOKE', address: '0x486415fb1F8b062c89ED548f871cf64304AACb31'},
      {name: 'PRIME_USDT_TSPOKE', address: '0x46c588DD8453aC259c1f6a54b4C9A93C2aC3762D'},
      {name: 'PRIME_WBTC_TSPOKE', address: '0x5AE3d87De89CA6Ce501e8317887F71EABED69E18'},
      {name: 'PRIME_wstETH_TSPOKE', address: '0xFCD3D3C69cd032DE0cc78fE529B7447D2fe7F666'},
      {name: 'PRIME_GHO_TSPOKE', address: '0x900fD46d565d1ac8995928c0179052ec02a6D0E1'},
      {name: 'PRIME_cbBTC_TSPOKE', address: '0xD38098faf52D8E915EdED84fBF30F81C17906938'},
    ],
    positionManagers: [
      {name: 'GIVER_PM', address: '0x17A54b8d6D9C68e7fa1C7112AC998EA1BA51d11e'},
      {name: 'TAKER_PM', address: '0x6c044c0D3801499bCAbfAd458B70880bc518e9F7'},
      {name: 'CONFIG_PM', address: '0x51305839CE822a7b4b12AA7D86eA7005052d575c'},
      {name: 'NATIVE_GW', address: '0xe68ab4F90Fe026B9873F5F276eD2d7efBbbE42Be'},
      {name: 'SIGNATURE_GW', address: '0xfbC184337Dc6595D8bf62968Bda46e7De7AF9c3d'},
    ],
    treasurySpoke: '0xB9B0b8616f6Bf6841972a52058132BE08d723155',
  },
  {
    chainId: 43114,
    chainAlias: 'avalanche',
    market: 'AaveV4Avalanche',
    hubs: [{name: 'CORE_HUB', address: '0xd07369fAE4A5BB13c9Ce446B052c7867B1AbDf6e'}],
    spokes: [
      {name: 'MAIN_SPOKE', address: '0x435272CefF93a1E657E8ABfdf0A13e95900A3a56'},
      {name: 'FOREX_SPOKE', address: '0x6a37776B5E026dBdF043b4F933c323C84DD1B514'},
      {name: 'AVAX_CORRELATED_SPOKE', address: '0x3b517594277c67307CF2d7CBE6FE1D4399B68c41'},
    ],
    tokenizationSpokes: [],
    positionManagers: [
      {name: 'GIVER_PM', address: '0x50c4C40aB6BaE46B372a251BEacE388439aa96b4'},
      {name: 'TAKER_PM', address: '0x5A5A711560eb9293Ef6F4bc33CD8589b4A603D10'},
      {name: 'CONFIG_PM', address: '0x50BE00C5EbF6CC230B8970f4205Cd0B5A70EaEB1'},
      {name: 'NATIVE_GW', address: '0xE4C7183A5f22c365140F41d733d8A8baD5A1a6bA'},
      {name: 'SIGNATURE_GW', address: '0x6E3B91A951DA9b515a5E98F0c7D210a697382e7F'},
    ],
    treasurySpoke: '0x2C4Aea1A5F000889c6DfFE8f52377aFc2CB113a6',
  },
];

export async function scanV4Chain(
  chain: ChainConfig,
  v4inv: V4ChainInventory,
  v3Targets: TargetRow[],
  cache: ScanCache,
  options: {repin?: boolean} = {}
): Promise<ChainScanResult> {
  const rpcUrl = getRpcUrl(chain);
  const multicallAddress = getMulticallAddress(chain.chainId);

  const chainDef = {
    id: chain.chainId,
    name: chain.alias,
    nativeCurrency: {name: 'Ether', symbol: 'ETH', decimals: 18},
    rpcUrls: {default: {http: [rpcUrl]}},
    contracts: {multicall3: {address: multicallAddress}},
  };

  const client: any = createPublicClient({
    chain: chainDef as any,
    transport: http(rpcUrl, {batch: false, timeout: 60_000, retryCount: 3, retryDelay: 1_000}),
    batch: {multicall: {batchSize: VIEM_BATCH_SIZE}},
  });

  // Determine block
  const cacheKey = `${chain.alias}-v4`;
  const cachedChain = cache.chains[cacheKey];
  let pinnedBlock: number;
  let pinnedAt: string;

  if (cachedChain?.pinnedBlock && !options.repin) {
    pinnedBlock = cachedChain.pinnedBlock;
    pinnedAt = cachedChain.pinnedAt;
    console.log(`  [V4] Using pinned block ${pinnedBlock} (pinned: ${pinnedAt})`);
  } else {
    const current = await client.getBlockNumber();
    pinnedBlock = Number(current);
    pinnedAt = new Date().toISOString();
    console.log(`  [V4] Pinning fresh block: ${pinnedBlock} at ${pinnedAt}`);
  }

  const block = BigInt(pinnedBlock);
  const findings: Finding[] = [];
  const cachedPrices: Record<string, CachedOraclePrice> = {};
  let oracleBaseUnit = '100000000';
  let totalChecks = 0;

  // ──────────────────────────────────────────────────────────────────────────
  // Step 1: Discover all unique underlyings across all Hubs
  // ──────────────────────────────────────────────────────────────────────────
  type HubAssetInfo = {
    hubName: string;
    hubAddress: Address;
    assetId: number;
    underlying: Address;
    decimals: number;
    symbol: string;
  };

  const allHubAssets: HubAssetInfo[] = [];

  for (const hub of v4inv.hubs) {
    console.log(`  [V4] Discovering assets for ${hub.name}...`);
    const countResult = await client.readContract({
      address: hub.address,
      abi: HUB_ABI,
      functionName: 'getAssetCount',
      blockNumber: block,
    });
    const assetCount = Number(countResult);

    // Batch read all underlying + decimals
    const assetInfoCalls: MulticallItem[] = [];
    for (let i = 0; i < assetCount; i++) {
      assetInfoCalls.push({
        address: hub.address,
        abi: HUB_ABI,
        functionName: 'getAssetUnderlyingAndDecimals',
        args: [BigInt(i)],
      });
    }

    const assetInfoResults = await client.multicall({
      contracts: assetInfoCalls as any,
      multicallAddress,
      blockNumber: block,
      batchSize: VIEM_BATCH_SIZE,
      allowFailure: true,
    });

    for (let i = 0; i < assetCount; i++) {
      const r = assetInfoResults[i];
      if (r.status === 'success' && r.result) {
        const [underlying, decimals] = r.result as [Address, number];
        // Resolve symbol via ERC20
        let symbol = `asset${i}`;
        try {
          const sym = await client.readContract({
            address: underlying,
            abi: parseAbi(['function symbol() view returns (string)']),
            blockNumber: block,
          });
          symbol = sym as string;
        } catch {}

        allHubAssets.push({
          hubName: hub.name,
          hubAddress: hub.address,
          assetId: i,
          underlying,
          decimals: Number(decimals),
          symbol,
        });
      }
    }
    console.log(`    Found ${assetCount} assets in ${hub.name}`);
  }

  // Build unique underlying set for checking stuck tokens later
  const uniqueUnderlyings = new Map<string, {address: Address; symbol: string; decimals: number}>();
  for (const a of allHubAssets) {
    uniqueUnderlyings.set(a.underlying.toLowerCase(), {
      address: a.underlying,
      symbol: a.symbol,
      decimals: a.decimals,
    });
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Step 2: Get prices using V3 oracle from same chain (works for same tokens)
  // ──────────────────────────────────────────────────────────────────────────
  const priceMap = new Map<string, bigint>();
  let oracleUnitBn = 100_000_000n;
  let oracleDecimals = 8;

  // Find V3 oracle on same chain from inventory
  const v3Pool = v3Targets.find(
    (t) => t.chainId === chain.chainId && t.targetType === 'pool' && t.oracle
  );

  if (v3Pool) {
    try {
      const v3Oracle = v3Pool.oracle;
      console.log(`  [V4] Using V3 oracle ${v3Oracle.slice(0, 10)}... for pricing`);

      // Get base currency unit
      const unitCalls: MulticallItem[] = [
        {address: v3Oracle, abi: ORACLE_ABI, functionName: 'BASE_CURRENCY_UNIT', args: []},
      ];
      const unitResults = await executeMulticall(client, chain.chainId, unitCalls, block);
      const rawUnit = unitResults[0] ?? 100_000_000n;
      oracleUnitBn = rawUnit;
      oracleBaseUnit = rawUnit.toString();
      oracleDecimals = rawUnit.toString().length - 1;

      // Get prices for all unique underlyings
      const priceCalls: MulticallItem[] = [...uniqueUnderlyings.values()].map((u) => ({
        address: v3Oracle,
        abi: ORACLE_ABI,
        functionName: 'getAssetPrice',
        args: [u.address],
      }));

      const priceResults = await executeMulticall(client, chain.chainId, priceCalls, block);

      const underlyingsList = [...uniqueUnderlyings.values()];
      let priced = 0;
      underlyingsList.forEach((u, idx) => {
        const price = priceResults[idx];
        if (price !== undefined && price > 0n) {
          priceMap.set(u.address.toLowerCase(), price);
          const priceUsd = formatUnits(price, oracleDecimals);
          cachedPrices[u.address.toLowerCase()] = {
            symbol: u.symbol,
            priceRaw: price.toString(),
            priceUsd,
          };
          priced++;
        }
      });
      console.log(`  [V4] Priced ${priced}/${underlyingsList.length} assets via V3 oracle`);
    } catch (err: any) {
      console.warn(`  [V4] Warning: could not fetch V3 oracle prices: ${err.message}`);
    }
  } else {
    console.warn(`  [V4] No V3 oracle found for ${chain.alias}, prices will be N/A`);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Step 3: Check Hub balances vs accounting
  // ──────────────────────────────────────────────────────────────────────────
  console.log(`  [V4] Checking Hub balances...`);

  for (const asset of allHubAssets) {
    const balanceCalls: MulticallItem[] = [
      {
        address: asset.underlying,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [asset.hubAddress],
      },
      {
        address: asset.hubAddress,
        abi: HUB_ABI,
        functionName: 'getAssetLiquidity',
        args: [BigInt(asset.assetId)],
      },
      {
        address: asset.hubAddress,
        abi: HUB_ABI,
        functionName: 'getAssetAccruedFees',
        args: [BigInt(asset.assetId)],
      },
    ];

    const results = await executeMulticall(client, chain.chainId, balanceCalls, block);
    const erc20Balance = results[0] ?? 0n;
    const liquidity = results[1] ?? 0n;
    const accruedFees = results[2] ?? 0n;
    totalChecks += 1;

    // In Aave V4, asset.liquidity tracks the exact unborrowed underlying balance
    // held in the Hub contract. Accrued fees represent interest owed by borrowers,
    // which mints shares to the fee receiver rather than physical tokens.
    // Therefore, the Hub expected balance is asset.liquidity.
    const expectedBalance = liquidity;
    const diff = erc20Balance - expectedBalance;

    if (diff !== 0n) {
      const kind: FindingKind = diff > 0n ? 'v4-hub-surplus' : 'v4-hub-deficit';
      const price = priceMap.get(asset.underlying.toLowerCase());
      const priceUsd = price !== undefined ? formatUnits(price, oracleDecimals) : undefined;
      const valueUsd =
        price !== undefined
          ? calculateUsdValue(diff, asset.decimals, price, oracleUnitBn)
          : undefined;

      findings.push({
        chainId: chain.chainId,
        chainAlias: chain.alias,
        market: v4inv.market,
        kind,
        holder: asset.hubAddress,
        holderSymbol: asset.hubName,
        token: asset.underlying,
        tokenSymbol: asset.symbol,
        decimals: asset.decimals,
        amount: diff.toString(),
        amountFormatted: formatUnits(diff, asset.decimals),
        virtualBalance: expectedBalance.toString(),
        ...(priceUsd !== undefined ? {priceUsd} : {}),
        ...(valueUsd !== undefined ? {valueUsd} : {}),
        note: `Hub ERC20=${formatUnits(erc20Balance, asset.decimals)}, liquidity=${formatUnits(liquidity, asset.decimals)}, fees=${formatUnits(accruedFees, asset.decimals)}`,
      });
    } else {
      const price = priceMap.get(asset.underlying.toLowerCase());
      const priceUsd = price !== undefined ? formatUnits(price, oracleDecimals) : undefined;
      findings.push({
        chainId: chain.chainId,
        chainAlias: chain.alias,
        market: v4inv.market,
        kind: 'v4-hub-clean',
        holder: asset.hubAddress,
        holderSymbol: asset.hubName,
        token: asset.underlying,
        tokenSymbol: asset.symbol,
        decimals: asset.decimals,
        amount: '0',
        amountFormatted: '0',
        virtualBalance: expectedBalance.toString(),
        ...(priceUsd !== undefined ? {priceUsd} : {}),
        valueUsd: '0.00',
        note: `Hub ERC20=${formatUnits(erc20Balance, asset.decimals)}, liquidity=${formatUnits(liquidity, asset.decimals)}, fees=${formatUnits(accruedFees, asset.decimals)} (Verified Clean)`,
      });
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Step 4: Check stuck tokens in Spokes, TokenizationSpokes, PositionManagers
  // ──────────────────────────────────────────────────────────────────────────
  type HolderDef = {address: Address; symbol: string; kind: FindingKind};

  const holdersToCheck: HolderDef[] = [
    ...v4inv.spokes.map((s) => ({
      address: s.address,
      symbol: s.name,
      kind: 'v4-token-in-spoke' as FindingKind,
    })),
    ...v4inv.tokenizationSpokes.map((s) => ({
      address: s.address,
      symbol: s.name,
      kind: 'v4-token-in-tokenization-spoke' as FindingKind,
    })),
    ...v4inv.positionManagers.map((s) => ({
      address: s.address,
      symbol: s.name,
      kind: 'v4-token-in-position-manager' as FindingKind,
    })),
  ];

  if (v4inv.treasurySpoke) {
    holdersToCheck.push({
      address: v4inv.treasurySpoke,
      symbol: 'TREASURY_SPOKE',
      kind: 'v4-token-in-spoke',
    });
  }

  console.log(
    `  [V4] Checking ${holdersToCheck.length} contracts for stuck tokens across ${uniqueUnderlyings.size} assets...`
  );

  // Build cartesian: holder x underlying
  const stuckCalls: MulticallItem[] = [];
  type StuckCheckInfo = {
    holder: HolderDef;
    underlying: {address: Address; symbol: string; decimals: number};
  };
  const stuckChecks: StuckCheckInfo[] = [];

  for (const holder of holdersToCheck) {
    for (const [, underlying] of uniqueUnderlyings) {
      stuckCalls.push({
        address: underlying.address,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [holder.address],
      });
      stuckChecks.push({holder, underlying});
    }
  }

  totalChecks += stuckChecks.length;
  const stuckResults = await executeMulticall(client, chain.chainId, stuckCalls, block);

  const holderStuckCount = new Map<string, number>();
  stuckChecks.forEach((check, idx) => {
    const balance = stuckResults[idx] ?? 0n;
    if (balance > 0n) {
      holderStuckCount.set(
        check.holder.address.toLowerCase(),
        (holderStuckCount.get(check.holder.address.toLowerCase()) ?? 0) + 1
      );
      const price = priceMap.get(check.underlying.address.toLowerCase());
      const priceUsd = price !== undefined ? formatUnits(price, oracleDecimals) : undefined;
      const valueUsd =
        price !== undefined
          ? calculateUsdValue(balance, check.underlying.decimals, price, oracleUnitBn)
          : undefined;

      findings.push({
        chainId: chain.chainId,
        chainAlias: chain.alias,
        market: v4inv.market,
        kind: check.holder.kind,
        holder: check.holder.address,
        holderSymbol: check.holder.symbol,
        token: check.underlying.address,
        tokenSymbol: check.underlying.symbol,
        decimals: check.underlying.decimals,
        amount: balance.toString(),
        amountFormatted: formatUnits(balance, check.underlying.decimals),
        ...(priceUsd !== undefined ? {priceUsd} : {}),
        ...(valueUsd !== undefined ? {valueUsd} : {}),
      });
    }
  });

  // For holders with 0 stuck tokens across all scanned assets, record verified clean entry
  for (const holder of holdersToCheck) {
    if ((holderStuckCount.get(holder.address.toLowerCase()) ?? 0) === 0) {
      findings.push({
        chainId: chain.chainId,
        chainAlias: chain.alias,
        market: v4inv.market,
        kind: 'v4-spoke-clean',
        holder: holder.address,
        holderSymbol: holder.symbol,
        token: '0x0000000000000000000000000000000000000000',
        tokenSymbol: `All Assets (${uniqueUnderlyings.size})`,
        decimals: 18,
        amount: '0',
        amountFormatted: '0',
        valueUsd: '0.00',
        note: `Verified clean: 0 stuck tokens across all ${uniqueUnderlyings.size} scanned assets`,
      });
    }
  }

  // Sort findings
  findings.sort(
    (a, b) => a.kind.localeCompare(b.kind) || a.tokenSymbol.localeCompare(b.tokenSymbol)
  );

  // Compute stats
  const allKinds: FindingKind[] = [
    'v4-hub-surplus',
    'v4-hub-deficit',
    'v4-token-in-spoke',
    'v4-token-in-tokenization-spoke',
    'v4-token-in-position-manager',
    'v4-hub-clean',
    'v4-spoke-clean',
  ];

  const byKind: Record<string, {count: number; totalValueUsd: string}> = {};
  for (const kind of allKinds) {
    const kf = findings.filter((f) => f.kind === kind);
    const kSums = sumCents(kf.map((f) => f.valueUsd));
    byKind[kind] = {count: kf.length, totalValueUsd: formatCents(kSums.netCents)};
  }

  const chainSums = sumCents(findings.map((f) => f.valueUsd));

  return {
    chainId: chain.chainId,
    alias: cacheKey,
    pinnedBlock,
    pinnedAt,
    oracleBaseUnit,
    oraclePrices: cachedPrices,
    stats: {
      marketsScanned: 1,
      tokensScanned: uniqueUnderlyings.size,
      checksPerformed: totalChecks,
      findingsCount: findings.length,
      surplusValueUsd: formatCents(chainSums.posCents),
      deficitValueUsd: formatCents(chainSums.negCents),
      netValueUsd: formatCents(chainSums.netCents),
      byMarket: {
        [v4inv.market]: {
          findingsCount: findings.length,
          surplusValueUsd: formatCents(chainSums.posCents),
          deficitValueUsd: formatCents(chainSums.negCents),
          netValueUsd: formatCents(chainSums.netCents),
          byKind,
        },
      },
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
  const isV4 = args.includes('--v4');
  const cacheFile =
    args
      .find((a, i) => args[i - 1] === '--cache' || a.startsWith('--cache='))
      ?.replace('--cache=', '') || path.resolve(process.cwd(), 'balances-cache.json');

  const cache = loadCache(cacheFile);

  if (isSummaryOnly) {
    printAggregatedTotals(cache);
    return;
  }

  console.log(`--- Aave V3${isV4 ? ' + V4' : ''} Viem Balance & Surplus Scanner ---`);
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

  // V3 Scanning
  if (!isV4) {
    for (const chain of targetChains) {
      console.log(`\n>>> Scanning V3 ${chain.alias} (ID: ${chain.chainId})...`);
      try {
        const result = await scanChain(chain, inventory, cache, {repin: isRepin});
        cache.chains[chain.alias] = result;
        saveCache(cacheFile, cache);
        printFindingsTable(result);
      } catch (err: any) {
        console.error(`Error scanning V3 ${chain.alias}: ${err.message}`);
      }
    }
  }

  // V4 Scanning
  if (isV4 || isAll) {
    const v4Chains = isAll
      ? V4_INVENTORY
      : V4_INVENTORY.filter((inv) => {
          const chainMatch = targetChains.find((tc) => tc.chainId === inv.chainId);
          return !!chainMatch;
        });

    for (const v4inv of v4Chains) {
      const chain = CHAINS.find((c) => c.chainId === v4inv.chainId);
      if (!chain) {
        console.warn(
          `No RPC config for V4 chain ${v4inv.chainAlias} (${v4inv.chainId}), skipping.`
        );
        continue;
      }
      console.log(`\n>>> Scanning V4 ${v4inv.market} on ${chain.alias} (ID: ${chain.chainId})...`);
      try {
        const result = await scanV4Chain(chain, v4inv, inventory, cache, {repin: isRepin});
        cache.chains[result.alias] = result;
        saveCache(cacheFile, cache);
        printFindingsTable(result);
      } catch (err: any) {
        console.error(`Error scanning V4 ${v4inv.market}: ${err.message}`);
      }
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
