import fs from 'fs';
import path from 'path';
import type {Address} from 'viem';
import type {Inventory, Market} from '../common/types';
import {loadMarkets, loadProvenance} from './addressBook';
import {CHAINS} from './chains';
import {canonicalJson, writeCanonical} from './canonical';

export const INVENTORY_PATH = path.resolve(__dirname, 'data/inventory.json');

/** A market discovery scans: every V4 market, and the V3 markets the DAO executor governs. */
export const discoverable = (m: Market): boolean => m.authority?.governedByDao ?? true;

/** Builds the inventory from the pinned address book. Pure. */
export function buildInventory(): Inventory {
  const markets = loadMarkets();
  const missing = CHAINS.filter(
    (c) => !markets.some((m) => m.chainId === c.chainId && m.protocol === 'v3')
  );
  if (missing.length)
    throw new Error(`no V3 market for chain(s): ${missing.map((c) => c.alias).join(', ')}`);
  // A V4 market has no oracle of its own in the address book; it values its tokens with the
  // chain's first DAO-governed V3 oracle, recorded here so the choice is part of the artifact.
  for (const m of markets) {
    if (m.protocol !== 'v4') continue;
    const v3 = markets.find(
      (x) => x.chainId === m.chainId && x.protocol === 'v3' && discoverable(x)
    );
    if (v3?.oracle) m.oracle = v3.oracle;
  }
  return {addressBook: loadProvenance(), markets};
}

export function marketOf(inventory: Inventory, chainId: number, market: string): Market {
  const m = inventory.markets.find((x) => x.chainId === chainId && x.market === market);
  if (!m) throw new Error(`no market ${market} on chain ${chainId} in the inventory`);
  return m;
}

/** The Pool of one V3 market. */
export function poolOf(inventory: Inventory, chainId: number, market: string): Address {
  const pool = marketOf(inventory, chainId, market).holders.find((h) => h.role === 'pool');
  if (!pool) throw new Error(`no pool in inventory for ${market} on chain ${chainId}`);
  return pool.address;
}

/** The committed inventory, which must equal a fresh build from the pinned address book. */
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
  const count = (protocol: string) => inventory.markets.filter((m) => m.protocol === protocol);
  const holders = (ms: Market[]) => ms.reduce((n, m) => n + m.holders.length, 0);
  const notDao = inventory.markets.filter((m) => !discoverable(m)).map((m) => m.market);
  console.log(
    `inventory: ${CHAINS.length} chains, ${count('v3').length} V3 markets with ${holders(count('v3'))} holders, ` +
      `${count('v4').length} V4 markets with ${holders(count('v4'))} holders ` +
      `(address book ${inventory.addressBook.tag}); not DAO-governed: ${notDao.join(', ') || 'none'}`
  );
  console.log(`written ${path.relative(process.cwd(), INVENTORY_PATH)} sha256 ${sha256}`);
}
