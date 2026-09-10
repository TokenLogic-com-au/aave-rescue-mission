import {execFileSync} from 'child_process';
import fs from 'fs';
import {describe, expect, it} from 'vitest';
import {canonicalJson, sha256} from './canonical';
import {CHAINS, EXCLUSIONS} from './chains';
import {ADDRESS_BOOK_DIR, ADDRESS_BOOK_PIN} from './addressBook';
import {buildInventory, INVENTORY_PATH} from './inventory';
import {Inventory} from '../common/types';

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

describe('inventory', () => {
  const inventory: Inventory = buildInventory();

  it('is deterministic and matches the committed artifact', () => {
    const a = canonicalJson(buildInventory());
    const b = canonicalJson(inventory);
    expect(sha256(a)).toBe(sha256(b));
    expect(fs.readFileSync(INVENTORY_PATH, 'utf8')).toBe(b);
  });

  it('covers every in-scope chain with one DAO executor per chain', () => {
    for (const chain of CHAINS) {
      const rows = inventory.targets.filter((t) => t.chainId === chain.chainId);
      expect(rows.length, chain.alias).toBeGreaterThan(0);
      const executors = new Set(rows.map((t) => t.executor));
      expect(executors.size, chain.alias).toBe(1);
      expect([...executors][0]).toMatch(ADDRESS);
    }
  });

  it('marks every market whose ACL admin is not the DAO executor, and lists it as excluded', () => {
    const notDao = new Set(inventory.targets.filter((t) => !t.governedByDao).map((t) => t.market));
    expect([...notDao]).toEqual(['AaveV3InkWhitelabel']);
    for (const market of notDao) {
      expect(
        EXCLUSIONS.some((e) => e.scope.startsWith(market)),
        market
      ).toBe(true);
    }
    for (const t of inventory.targets) {
      expect(t.governedByDao, t.market).toBe(t.aclAdmin.toLowerCase() === t.executor.toLowerCase());
    }
  });

  it('is built from address book v4.66.4 exactly', () => {
    expect(inventory.addressBook).toEqual({
      repository: 'https://github.com/aave-dao/aave-address-book',
      tag: 'v4.66.4',
      commit: '09a66451e85dfaf056d2ce16fb1f226f3bd0dcd9',
    });
  });

  it('reads the Foundry submodule at the pinned commit, so Solidity and scripts share one release', () => {
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', ADDRESS_BOOK_DIR, ...args], {encoding: 'utf8'}).trim();
    expect(git('rev-parse', 'HEAD')).toBe(ADDRESS_BOOK_PIN.commit);
    expect(git('describe', '--tags', '--exact-match')).toBe(inventory.addressBook.tag);
  });

  it('gives every row an in-scope chain, ACL addresses, a source and a well-formed target', () => {
    const inScope = new Set(CHAINS.map((c) => c.chainId));
    for (const t of inventory.targets) {
      expect(inScope.has(t.chainId)).toBe(true);
      expect(t.target).toMatch(ADDRESS);
      expect(t.aclAdmin).toMatch(ADDRESS);
      expect(t.aclManager).toMatch(ADDRESS);
      expect(t.oracle).toMatch(ADDRESS);
      expect(t.source).toContain(t.market);
      if (t.targetType === 'aToken') {
        expect(t.underlying).toMatch(ADDRESS);
        expect(t.symbol).toBeTruthy();
        expect(Number.isInteger(t.decimals)).toBe(true);
      } else {
        expect(t.underlying).toBeUndefined();
      }
    }
  });

  it('has exactly one pool per market and no duplicate targets within a chain', () => {
    const markets = new Set(inventory.targets.map((t) => t.market));
    for (const market of markets) {
      expect(
        inventory.targets.filter((t) => t.market === market && t.targetType === 'pool')
      ).toHaveLength(1);
    }
    const seen = new Set<string>();
    for (const t of inventory.targets) {
      const key = `${t.chainId}:${t.market}:${t.target.toLowerCase()}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });

  it('includes the two regression-fixture targets on Ethereum Core', () => {
    const aEthUSDC = inventory.targets.find(
      (t) => t.chainId === 1 && t.market === 'AaveV3Ethereum' && t.symbol === 'USDC'
    );
    expect(aEthUSDC?.target).toBe('0x98C23E9d8f34FEFb1B7BD6a91B7FF122F4e16F5c');
    expect(aEthUSDC?.underlying).toBe('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48');
    expect(aEthUSDC?.decimals).toBe(6);
    expect(aEthUSDC?.executor).toBe('0x5300A1a15135EA4dc7aD5a167152C01EFc9b192A');
    expect(aEthUSDC?.governedByDao).toBe(true);
  });
});
