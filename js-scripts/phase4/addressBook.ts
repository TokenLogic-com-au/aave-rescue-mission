import path from 'path';
import type {Address} from 'viem';
import * as AddressBook from '../../lib/aave-address-book/src/ts/AaveAddressBook';
import {CHAIN_IDS, chainById} from './chains';
import {compareAddresses, compareStrings} from './canonical';
import {checkSubmodulePin} from './submodule';
import type {
  GovernanceModule,
  Holder,
  Market,
  MarketModule,
  Provenance,
  Token,
  V4Module,
} from '../common/types';

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

const byAddress = <T extends {address: Address}>(rows: T[]): T[] =>
  rows.sort((a, b) => compareAddresses(a.address, b.address));

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

/** V3 markets on in-scope chains: the Pool and every aToken as holders, each reserve's underlying and aToken as tokens. */
function v3Markets(executors: Map<number, Address>): Market[] {
  const markets: Market[] = [];
  for (const [name, mod] of modules) {
    if (!name.startsWith('AaveV3')) continue;
    const m = mod as MarketModule;
    if (m.CHAIN_ID === undefined || !m.POOL || !m.ASSETS || !CHAIN_IDS.has(m.CHAIN_ID)) continue;
    if (!m.ACL_ADMIN || !m.ACL_MANAGER || !m.ORACLE)
      throw new Error(`${name}: missing ACL_ADMIN, ACL_MANAGER or ORACLE`);
    const executor = executors.get(m.CHAIN_ID);
    if (!executor) throw new Error(`${name}: no Governance V3 executor for chain ${m.CHAIN_ID}`);
    const pool = m.POOL as Address;
    const holders: Holder[] = [{name: 'Pool', address: pool, role: 'pool', source: `${name}.POOL`}];
    const tokens: Token[] = [];
    for (const [symbol, a] of Object.entries(m.ASSETS)) {
      const underlying = a.UNDERLYING as Address;
      const aToken = a.A_TOKEN as Address;
      const source = `${name}.ASSETS.${symbol}`;
      holders.push({
        name: `a${symbol}`,
        address: aToken,
        role: 'aToken',
        floor: {rule: 'virtualBalance', pool, token: underlying},
        source,
      });
      tokens.push({
        address: underlying,
        symbol,
        decimals: a.decimals,
        pricedBy: underlying,
        source,
      });
      tokens.push({
        address: aToken,
        symbol: `a${symbol}`,
        decimals: a.decimals,
        pricedBy: underlying,
        source,
      });
    }
    markets.push({
      market: name,
      protocol: 'v3',
      chainId: m.CHAIN_ID,
      chainAlias: chainById(m.CHAIN_ID).alias,
      oracle: m.ORACLE as Address,
      authority: {
        executor,
        aclAdmin: m.ACL_ADMIN as Address,
        aclManager: m.ACL_MANAGER as Address,
        // The executor governs the market only if it is the ACL admin; whitelabel and other
        // permissioned instances have a different admin and are out of a DAO payload's reach.
        governedByDao: m.ACL_ADMIN.toLowerCase() === executor.toLowerCase(),
      },
      holders: byAddress(holders),
      tokens: byAddress(tokens),
    });
  }
  return markets;
}

const V4_GROUPS: [keyof V4Module, Holder['role']][] = [
  ['HUBS', 'hub'],
  ['SPOKES', 'spoke'],
  ['TOKENIZATION_SPOKES', 'tokenizationSpoke'],
  ['POSITION_MANAGERS', 'positionManager'],
];

/** V4 markets on in-scope chains: hubs (with the liquidity floor), spokes, tokenization spokes and position managers as holders, listed assets as tokens. */
function v4Markets(): Market[] {
  const markets: Market[] = [];
  for (const [name, mod] of modules) {
    if (!name.startsWith('AaveV4')) continue;
    const m = mod as V4Module;
    if (m.CHAIN_ID === undefined || !m.HUBS || !CHAIN_IDS.has(m.CHAIN_ID)) continue;
    const holders: Holder[] = [];
    for (const [group, role] of V4_GROUPS) {
      for (const [key, address] of Object.entries(
        (m[group] as Record<string, string> | undefined) ?? {}
      )) {
        if (key.endsWith('_ORACLE')) continue;
        holders.push({
          name: key,
          address: address as Address,
          role,
          ...(role === 'hub' ? {floor: {rule: 'hubLiquidity' as const}} : {}),
          source: `${name}.${group}.${key}`,
        });
      }
    }
    const tokens: Token[] = Object.entries(m.ASSETS ?? {}).map(([symbol, a]) => ({
      address: a.UNDERLYING as Address,
      symbol,
      decimals: a.decimals,
      pricedBy: a.UNDERLYING as Address,
      source: `${name}.ASSETS.${symbol}`,
    }));
    markets.push({
      market: name,
      protocol: 'v4',
      chainId: m.CHAIN_ID,
      chainAlias: chainById(m.CHAIN_ID).alias,
      holders: byAddress(holders),
      tokens: byAddress(tokens),
    });
  }
  return markets;
}

/** Every market on an in-scope chain, V3 and V4, ordered by chain then name. */
export function loadMarkets(): Market[] {
  return [...v3Markets(loadExecutors()), ...v4Markets()].sort(
    (a, b) => a.chainId - b.chainId || compareStrings(a.market, b.market)
  );
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
