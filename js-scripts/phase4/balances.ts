import fs from 'fs';
import path from 'path';
import {erc20Abi, formatUnits, parseAbi, type Address} from 'viem';
import {Call, ChainReader, ChainReaders, envChainReaders, strict} from './chain';
import {assertChainId, CHAINS, ChainConfig, rpcEnv} from './chains';
import {compareAddresses, compareStrings, sha256, writeCanonical} from './canonical';
import {ChainFailure, chainFailure, runCli} from './cli';
import {discoverable, readVerifiedInventory} from './inventory';
import {PINNED_AT} from './policy';
import {parseInstant, RUN_PATH, RunManifest} from './ranges';
import {usdValue} from './usd';
import {Holder, Inventory, Market, Token} from '../common/types';

/**
 * Balance-first discovery at each chain's pinned block. Every token a market deals in is read
 * in every holder the market has. A holder with a floor legitimately holds one or more tokens up
 * to the protocol's own figure for it (an aToken its underlying up to the Pool's virtual balance,
 * a hub each listed asset up to the hub's liquidity), so only the surplus over the floor is stuck;
 * every other balance found is stuck outright. Amounts are base-unit integers; formatted amounts
 * and USD values (the market's oracle at the same block) are annotations for readers and for the
 * eligibility policy.
 */
export type HoldingKind =
  | 'underlying-in-own-atoken'
  | 'atoken-in-itself'
  | 'market-token-in-atoken'
  | 'market-token-in-pool'
  | 'underlying-in-own-hub'
  | 'market-token-in-v4-contract';

export type Holding = {
  chainId: number;
  chainAlias: string;
  market: string;
  kind: HoldingKind;
  holder: Address;
  holderSymbol: string;
  token: Address;
  tokenSymbol: string;
  decimals: number;
  /** Base units; negative only for a surplus below the floor, which needs review. */
  amount: string;
  amountFormatted: string;
  /** The floor the surplus was measured against: the Pool's virtual balance, or the hub's liquidity. */
  virtualBalance?: string;
  /** Oracle price in USD (formatted) and the resulting value; absent when the oracle had no price. */
  priceUsd?: string;
  valueUsd?: string;
  note?: string;
};

export type ChainBalances = {
  chainId: number;
  alias: string;
  block: number;
  holdings: Holding[];
};

export type BalancesManifest = {
  runSha256: string;
  inventorySha256: string;
  chains: ChainBalances[];
  failures: ChainFailure[];
};

export const BALANCES_PATH = path.resolve(__dirname, 'data/balances.json');

const POOL_ABI = parseAbi([
  'function getVirtualUnderlyingBalance(address asset) view returns (uint128)',
]);
const ORACLE_ABI = parseAbi([
  'function BASE_CURRENCY_UNIT() view returns (uint256)',
  'function getAssetPrice(address asset) view returns (uint256)',
]);
const HUB_ABI = parseAbi([
  'function getAssetCount() view returns (uint256)',
  'function getAssetUnderlyingAndDecimals(uint256 assetId) view returns (address, uint8)',
  'function getAssetLiquidity(uint256 assetId) view returns (uint256)',
  'function getAssetAccruedFees(uint256 assetId) view returns (uint256)',
]);

/** One asset a hub lists, with the hub's own figures for it. */
export type HubAsset = {
  market: string;
  hub: Address;
  hubName: string;
  assetId: number;
  underlying: Address;
  symbol: string;
  decimals: number;
  liquidity: bigint;
  accruedFees: bigint;
};

/** What a market scan covered, for readers that report coverage as well as findings. */
export type MarketScan = {
  market: Market;
  holdings: Holding[];
  hubAssets: HubAsset[];
  checks: number;
};

export type ChainScan = {holdings: Holding[]; markets: MarketScan[]};

const key = (holder: Address, token: Address) => `${holder}:${token}`.toLowerCase();

function kindOf(market: Market, holder: Holder, token: Token, own: boolean): HoldingKind {
  if (market.protocol === 'v4')
    return own ? 'underlying-in-own-hub' : 'market-token-in-v4-contract';
  if (own) return 'underlying-in-own-atoken';
  if (holder.role === 'pool') return 'market-token-in-pool';
  if (token.address === holder.address) return 'atoken-in-itself';
  return 'market-token-in-atoken';
}

async function hubAssets(
  reader: ChainReader,
  market: Market,
  hub: Holder,
  block: bigint
): Promise<HubAsset[]> {
  const [count] = strict<bigint>(
    await reader.read([{address: hub.address, abi: HUB_ABI, functionName: 'getAssetCount'}], block),
    'getAssetCount'
  );
  const ids = Array.from({length: Number(count)}, (_, i) => BigInt(i));
  const calls = (functionName: string): Call[] =>
    ids.map((id) => ({address: hub.address, abi: HUB_ABI, functionName, args: [id]}));
  const [info, liquidity, fees] = await Promise.all([
    reader
      .read(calls('getAssetUnderlyingAndDecimals'), block)
      .then((v) => strict<[Address, number]>(v, 'getAssetUnderlyingAndDecimals')),
    reader
      .read(calls('getAssetLiquidity'), block)
      .then((v) => strict<bigint>(v, 'getAssetLiquidity')),
    reader
      .read(calls('getAssetAccruedFees'), block)
      .then((v) => strict<bigint>(v, 'getAssetAccruedFees')),
  ]);
  // The hub's listing is the evidence; an asset listed after the address-book pin is named from chain.
  const symbolOf = new Map(market.tokens.map((t) => [t.address.toLowerCase(), t.symbol]));
  const unknown = info.map(([u]) => u).filter((u) => !symbolOf.has(u.toLowerCase()));
  const symbols = await reader.read(
    unknown.map((u) => ({address: u, abi: erc20Abi, functionName: 'symbol'})),
    block
  );
  unknown.forEach((u, i) =>
    symbolOf.set(u.toLowerCase(), (symbols[i] as string | undefined) ?? u.slice(0, 10))
  );
  return ids.map((id, i) => {
    const [underlying, decimals] = info[i];
    const symbol = symbolOf.get(underlying.toLowerCase())!;
    return {
      market: market.market,
      hub: hub.address,
      hubName: hub.name,
      assetId: Number(id),
      underlying,
      symbol,
      decimals: Number(decimals),
      liquidity: liquidity[i],
      accruedFees: fees[i],
    };
  });
}

/** Floors for one market: `${holder}:${token}` -> the amount the holder legitimately holds. */
async function floors(
  reader: ChainReader,
  market: Market,
  block: bigint
): Promise<{floor: Map<string, bigint>; hubAssets: HubAsset[]}> {
  const floor = new Map<string, bigint>();
  const virtual = market.holders.filter((h) => h.floor?.rule === 'virtualBalance');
  const values = strict<bigint>(
    await reader.read(
      virtual.map((h) => {
        const f = h.floor as Extract<Holder['floor'], {rule: 'virtualBalance'}>;
        return {
          address: f.pool,
          abi: POOL_ABI,
          functionName: 'getVirtualUnderlyingBalance',
          args: [f.token],
        };
      }),
      block
    ),
    'getVirtualUnderlyingBalance'
  );
  virtual.forEach((h, i) =>
    floor.set(key(h.address, (h.floor as {token: Address}).token), values[i])
  );
  const assets: HubAsset[] = [];
  for (const hub of market.holders.filter((h) => h.floor?.rule === 'hubLiquidity')) {
    for (const a of await hubAssets(reader, market, hub, block)) {
      floor.set(key(hub.address, a.underlying), a.liquidity);
      assets.push(a);
    }
  }
  return {floor, hubAssets: assets};
}

async function prices(
  reader: ChainReader,
  market: Market,
  block: bigint
): Promise<{unit: bigint; priceOf: Map<string, bigint | undefined>}> {
  const assets = [...new Set(market.tokens.map((t) => t.pricedBy.toLowerCase()))].map(
    (a) => a as Address
  );
  if (!market.oracle) return {unit: 0n, priceOf: new Map()};
  const [unit, ...values] = await reader.read(
    [
      {address: market.oracle, abi: ORACLE_ABI, functionName: 'BASE_CURRENCY_UNIT'},
      ...assets.map((a) => ({
        address: market.oracle!,
        abi: ORACLE_ABI,
        functionName: 'getAssetPrice',
        args: [a],
      })),
    ],
    block
  );
  if (unit === undefined) throw new Error('oracle BASE_CURRENCY_UNIT failed');
  return {
    unit: unit as bigint,
    priceOf: new Map(assets.map((a, i) => [a.toLowerCase(), values[i] as bigint | undefined])),
  };
}

function compareHoldings(a: Holding, b: Holding): number {
  return (
    compareStrings(a.market, b.market) ||
    compareAddresses(a.holder, b.holder) ||
    compareAddresses(a.token, b.token)
  );
}

/** Every token in every holder of one market at `block`, net of the holder's floor where it has one. */
export async function marketHoldings(
  chain: ChainConfig,
  reader: ChainReader,
  market: Market,
  block: bigint
): Promise<MarketScan> {
  const {floor, hubAssets} = await floors(reader, market, block);
  // Every token the market deals in, plus any asset a hub lists that the address-book pin lacks.
  const tokens: Token[] = [...market.tokens];
  for (const a of hubAssets) {
    if (tokens.some((t) => t.address.toLowerCase() === a.underlying.toLowerCase())) continue;
    tokens.push({
      address: a.underlying,
      symbol: a.symbol,
      decimals: a.decimals,
      pricedBy: a.underlying,
      source: `${a.hubName} listing, not in the address-book pin`,
    });
  }
  const pairs = market.holders.flatMap((holder) => tokens.map((token) => ({holder, token})));
  const [balances, {unit, priceOf}] = await Promise.all([
    reader
      .read(
        pairs.map((p) => ({
          address: p.token.address,
          abi: erc20Abi,
          functionName: 'balanceOf',
          args: [p.holder.address],
        })),
        block
      )
      .then((v) => strict<bigint>(v, 'balanceOf')),
    prices(reader, {...market, tokens}, block),
  ]);
  const priceDecimals = unit.toString().length - 1;
  const holdings: Holding[] = [];
  pairs.forEach(({holder, token}, i) => {
    const own = floor.get(key(holder.address, token.address));
    const amount = own === undefined ? balances[i] : balances[i] - own;
    if (amount === 0n) return;
    let note: string | undefined;
    if (own !== undefined && holder.floor?.rule === 'virtualBalance') {
      if (own === 0n)
        note = 'virtual balance is zero: reserve may not use virtual accounting; review';
      else if (amount < 0n) note = 'balance below virtual balance; review';
    } else if (own !== undefined && amount < 0n) {
      note = 'balance below hub liquidity; review';
    }
    const price = priceOf.get(token.pricedBy.toLowerCase());
    holdings.push({
      chainId: chain.chainId,
      chainAlias: chain.alias,
      market: market.market,
      kind: kindOf(market, holder, token, own !== undefined),
      holder: holder.address,
      holderSymbol: holder.name,
      token: token.address,
      tokenSymbol: token.symbol,
      decimals: token.decimals,
      amount: amount.toString(),
      amountFormatted: formatUnits(amount, token.decimals),
      ...(own !== undefined ? {virtualBalance: own.toString()} : {}),
      ...(price !== undefined
        ? {
            priceUsd: formatUnits(price, priceDecimals),
            valueUsd: usdValue(amount, token.decimals, price, unit),
          }
        : {}),
      ...(note ? {note} : {}),
    });
  });
  return {market, holdings: holdings.sort(compareHoldings), hubAssets, checks: pairs.length};
}

/** Every discoverable market on the chain at `block`. */
export async function chainScan(
  chain: ChainConfig,
  reader: ChainReader,
  inventory: Inventory,
  block: bigint
): Promise<ChainScan> {
  const markets: MarketScan[] = [];
  for (const market of inventory.markets.filter(
    (m) => m.chainId === chain.chainId && discoverable(m)
  ))
    markets.push(await marketHoldings(chain, reader, market, block));
  return {holdings: markets.flatMap((m) => m.holdings).sort(compareHoldings), markets};
}

export async function buildBalances(
  inventory: Inventory,
  inventoryText: string,
  run: RunManifest,
  runText: string,
  readers: ChainReaders,
  log: (line: string) => void = () => {}
): Promise<BalancesManifest> {
  if (run.failures.length) throw new Error('run.json is not final: it has failures');
  if (run.inventorySha256 !== sha256(inventoryText))
    throw new Error('run.json was pinned against a different inventory');
  if (run.pinnedAt !== parseInstant(PINNED_AT).toISOString())
    throw new Error('run.json is not pinned at PINNED_AT');
  const manifest: BalancesManifest = {
    runSha256: sha256(runText),
    inventorySha256: run.inventorySha256,
    chains: [],
    failures: [],
  };
  for (const chain of CHAINS) {
    const range = run.chains.find((c) => c.chainId === chain.chainId);
    const reader = readers(chain);
    try {
      if (!range) throw new Error('not pinned in run.json');
      if (!reader) throw new Error(`missing ${rpcEnv(chain)} or ALCHEMY_API_KEY`);
      assertChainId(await reader.chainId(), chain);
      log(`${chain.alias} (${chain.chainId}): reading balances at block ${range.toBlock}...`);
      const {holdings} = await chainScan(chain, reader, inventory, BigInt(range.toBlock));
      manifest.chains.push({
        chainId: chain.chainId,
        alias: chain.alias,
        block: range.toBlock,
        holdings,
      });
      log(`${chain.alias} (${chain.chainId}): ${holdings.length} holding(s)`);
    } catch (error) {
      manifest.failures.push(chainFailure(chain, error, log));
    }
  }
  manifest.chains.sort((a, b) => a.chainId - b.chainId);
  manifest.failures.sort((a, b) => a.chainId - b.chainId);
  return manifest;
}

if (require.main === module)
  runCli(async () => {
    const {inventory, text: inventoryText} = readVerifiedInventory();
    const runText = fs.readFileSync(RUN_PATH, 'utf8');
    const manifest = await buildBalances(
      inventory,
      inventoryText,
      JSON.parse(runText),
      runText,
      envChainReaders(),
      console.log
    );
    const digest = writeCanonical(BALANCES_PATH, manifest);
    const total = manifest.chains.reduce((n, c) => n + c.holdings.length, 0);
    console.log(
      `balances: ${manifest.chains.length} chains, ${total} holdings, ${manifest.failures.length} failed, ` +
        `written ${path.relative(process.cwd(), BALANCES_PATH)} (sha256 ${digest})`
    );
    if (manifest.failures.length) process.exitCode = 1;
  });
