import path from 'path';
import type {Address} from 'viem';
import * as AddressBook from '../../lib/aave-address-book/src/ts/AaveAddressBook';
import {CHAIN_IDS} from './chains';
import {compareAddresses, compareStrings} from './canonical';
import {checkSubmodulePin} from './submodule';
import type {Market, MarketModule, GovernanceModule, Provenance} from '../common/types';

/**
 * The address book is the Foundry submodule in lib/, read through the TypeScript constants it
 * ships next to the Solidity libraries, so Solidity and scripts see one release. Pinned by
 * commit; bump deliberately, then regenerate the inventory.
 */
export const ADDRESS_BOOK_DIR = path.resolve(__dirname, '../../lib/aave-address-book');
export const ADDRESS_BOOK_PIN = {
  repository: 'https://github.com/aave-dao/aave-address-book',
  commit: '09a66451e85dfaf056d2ce16fb1f226f3bd0dcd9',
} as const;

const modules = Object.entries(AddressBook) as [string, Record<string, unknown>][];

/** Production V3 markets on in-scope chains, from the pinned address book. */
export function loadMarkets(): Market[] {
  const markets: Market[] = [];
  for (const [name, mod] of modules) {
    if (!name.startsWith('AaveV3')) continue;
    const m = mod as MarketModule;
    if (m.CHAIN_ID === undefined || !m.POOL || !m.ASSETS) continue;
    if (!CHAIN_IDS.has(m.CHAIN_ID)) continue;
    if (!m.ACL_ADMIN || !m.ACL_MANAGER || !m.ORACLE) {
      throw new Error(`${name}: missing ACL_ADMIN, ACL_MANAGER or ORACLE`);
    }
    const assets = Object.entries(m.ASSETS)
      .map(([symbol, a]) => ({
        symbol,
        underlying: a.UNDERLYING as Address,
        aToken: a.A_TOKEN as Address,
        decimals: a.decimals,
      }))
      .sort((x, y) => compareAddresses(x.aToken, y.aToken));
    markets.push({
      market: name,
      chainId: m.CHAIN_ID,
      pool: m.POOL as Address,
      aclAdmin: m.ACL_ADMIN as Address,
      aclManager: m.ACL_MANAGER as Address,
      oracle: m.ORACLE as Address,
      assets,
    });
  }
  return markets.sort((a, b) => compareStrings(a.market, b.market));
}

/** Governance V3 Level 1 executor per in-scope chain id. */
export function loadExecutors(): Map<number, Address> {
  const executors = new Map<number, Address>();
  for (const [name, mod] of modules) {
    if (!name.startsWith('GovernanceV3')) continue;
    const g = mod as GovernanceModule;
    if (g.CHAIN_ID === undefined || !g.EXECUTOR_LVL_1 || !CHAIN_IDS.has(g.CHAIN_ID)) continue;
    executors.set(g.CHAIN_ID, g.EXECUTOR_LVL_1 as Address);
  }
  return executors;
}

/** The submodule's release, after checking it is clean and at ADDRESS_BOOK_PIN. */
export function loadProvenance(): Provenance {
  const {commit, tag} = checkSubmodulePin(
    ADDRESS_BOOK_DIR,
    'lib/aave-address-book',
    ADDRESS_BOOK_PIN.commit
  );
  if (!tag) throw new Error('lib/aave-address-book is not on a release tag');
  return {repository: ADDRESS_BOOK_PIN.repository, tag, commit};
}
