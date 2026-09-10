import fs from 'fs';
import path from 'path';
import type {Address} from 'viem';
import type {Inventory, Target, TargetType} from '../common/types';
import {loadExecutors, loadMarkets, loadProvenance} from './addressBook';
import {CHAINS, chainById} from './chains';
import {canonicalJson, compareAddresses, compareStrings, writeCanonical} from './canonical';

export const INVENTORY_PATH = path.resolve(__dirname, 'data/inventory.json');

const TYPE_ORDER: Record<TargetType, number> = {pool: 0, aToken: 1};

function compareTargets(a: Target, b: Target): number {
  return (
    a.chainId - b.chainId ||
    compareStrings(a.market, b.market) ||
    TYPE_ORDER[a.targetType] - TYPE_ORDER[b.targetType] ||
    compareAddresses(a.target, b.target)
  );
}

/** Builds the inventory from the pinned address-book package. Pure. */
export function buildInventory(): Inventory {
  const markets = loadMarkets();
  const executors = loadExecutors();

  const missingExecutor = CHAINS.filter((c) => !executors.has(c.chainId));
  if (missingExecutor.length) {
    throw new Error(
      `no Governance V3 executor for chain(s): ${missingExecutor.map((c) => c.alias).join(', ')}`
    );
  }
  const missingMarket = CHAINS.filter((c) => !markets.some((m) => m.chainId === c.chainId));
  if (missingMarket.length) {
    throw new Error(`no V3 market for chain(s): ${missingMarket.map((c) => c.alias).join(', ')}`);
  }

  const targets: Target[] = [];
  for (const m of markets) {
    const chain = chainById(m.chainId);
    const executor = executors.get(m.chainId)!;
    const common = {
      chainId: m.chainId,
      chainAlias: chain.alias,
      market: m.market,
      executor,
      aclAdmin: m.aclAdmin,
      aclManager: m.aclManager,
      oracle: m.oracle,
      // The executor governs the market only if it is the ACL admin; whitelabel and other
      // permissioned instances have a different admin and are out of a DAO payload's reach.
      governedByDao: m.aclAdmin.toLowerCase() === executor.toLowerCase(),
    };
    targets.push({...common, targetType: 'pool', target: m.pool, source: `${m.market}.POOL`});
    for (const a of m.assets) {
      targets.push({
        ...common,
        targetType: 'aToken',
        target: a.aToken,
        underlying: a.underlying,
        symbol: a.symbol,
        decimals: a.decimals,
        source: `${m.market}.ASSETS.${a.symbol}`,
      });
    }
  }
  targets.sort(compareTargets);
  return {addressBook: loadProvenance(), targets};
}

/** The committed inventory, accepted only if it equals a fresh build from the pinned address book. */
/** The Pool of one market. */
export function poolOf(inventory: Inventory, chainId: number, market: string): Address {
  const pool = inventory.targets.find(
    (t) => t.chainId === chainId && t.market === market && t.targetType === 'pool'
  );
  if (!pool) throw new Error(`no pool in inventory for ${market} on chain ${chainId}`);
  return pool.target;
}

export function readVerifiedInventory(): {inventory: Inventory; text: string} {
  const text = fs.readFileSync(INVENTORY_PATH, 'utf8');
  if (text !== canonicalJson(buildInventory())) {
    throw new Error(
      `${path.relative(process.cwd(), INVENTORY_PATH)} differs from the pinned address book; run phase4:inventory`
    );
  }
  return {inventory: JSON.parse(text), text};
}

if (require.main === module) {
  const inventory = buildInventory();
  const sha256 = writeCanonical(INVENTORY_PATH, inventory);
  const pools = inventory.targets.filter((t) => t.targetType === 'pool').length;
  const notDao = new Set(inventory.targets.filter((t) => !t.governedByDao).map((t) => t.market));
  console.log(
    `inventory: ${CHAINS.length} chains, ${pools} pools, ${inventory.targets.length - pools} aTokens ` +
      `(address book ${inventory.addressBook.tag}); not DAO-governed: ${[...notDao].join(', ') || 'none'}`
  );
  console.log(`written ${path.relative(process.cwd(), INVENTORY_PATH)} sha256 ${sha256}`);
}
