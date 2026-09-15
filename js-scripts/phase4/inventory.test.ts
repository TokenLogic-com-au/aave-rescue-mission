import {execFileSync} from 'child_process';
import fs from 'fs';
import {describe, expect, it} from 'vitest';
import {canonicalJson, sha256} from './canonical';
import {CHAINS, EXCLUSIONS} from './chains';
import {ADDRESS_BOOK_DIR, ADDRESS_BOOK_PIN} from './addressBook';
import {buildInventory, discoverable, INVENTORY_PATH, poolOf} from './inventory';
import {Inventory} from '../common/types';

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

describe('inventory', () => {
  const inventory: Inventory = buildInventory();
  const v3 = inventory.markets.filter((m) => m.protocol === 'v3');
  const v4 = inventory.markets.filter((m) => m.protocol === 'v4');

  it('is deterministic and matches the committed artifact', () => {
    const a = canonicalJson(buildInventory());
    const b = canonicalJson(inventory);
    expect(sha256(a)).toBe(sha256(b));
    expect(fs.readFileSync(INVENTORY_PATH, 'utf8')).toBe(b);
  });

  it('covers every in-scope chain with a V3 market and one DAO executor per chain', () => {
    for (const chain of CHAINS) {
      const markets = v3.filter((m) => m.chainId === chain.chainId);
      expect(markets.length, chain.alias).toBeGreaterThan(0);
      const executors = new Set(markets.map((m) => m.authority!.executor));
      expect(executors.size, chain.alias).toBe(1);
      expect([...executors][0]).toMatch(ADDRESS);
    }
  });

  it('marks every market whose ACL admin is not the DAO executor, lists it as excluded, and never scans it', () => {
    const notDao = v3.filter((m) => !m.authority!.governedByDao).map((m) => m.market);
    expect(notDao).toEqual(['AaveV3InkWhitelabel']);
    for (const market of notDao) {
      expect(
        EXCLUSIONS.some((e) => e.scope.startsWith(market)),
        market
      ).toBe(true);
    }
    for (const m of v3) {
      const {executor, aclAdmin, governedByDao} = m.authority!;
      expect(governedByDao, m.market).toBe(aclAdmin.toLowerCase() === executor.toLowerCase());
      expect(discoverable(m)).toBe(governedByDao);
    }
    for (const m of v4) expect(discoverable(m)).toBe(true);
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

  it('gives every holder and token a well-formed address, a source naming the market, and a priced-by token', () => {
    const inScope = new Set(CHAINS.map((c) => c.chainId));
    for (const m of inventory.markets) {
      expect(inScope.has(m.chainId), m.market).toBe(true);
      expect(m.oracle, m.market).toMatch(ADDRESS);
      const tokens = new Set(m.tokens.map((t) => t.address.toLowerCase()));
      for (const h of m.holders) {
        expect(h.address).toMatch(ADDRESS);
        expect(h.source).toContain(m.market);
      }
      for (const t of m.tokens) {
        expect(t.address).toMatch(ADDRESS);
        expect(t.source).toContain(m.market);
        expect(t.symbol).toBeTruthy();
        expect(Number.isInteger(t.decimals)).toBe(true);
        expect(tokens.has(t.pricedBy.toLowerCase()), `${m.market} ${t.symbol}`).toBe(true);
      }
    }
  });

  it('gives each V3 market one Pool, and each aToken a virtual-balance floor on its own underlying', () => {
    for (const m of v3) {
      expect(
        m.holders.filter((h) => h.role === 'pool'),
        m.market
      ).toHaveLength(1);
      expect(poolOf(inventory, m.chainId, m.market)).toBe(
        m.holders.find((h) => h.role === 'pool')!.address
      );
      const underlyings = new Set<string>(
        m.tokens.filter((t) => t.pricedBy === t.address).map((t) => t.address)
      );
      for (const h of m.holders.filter((h) => h.role === 'aToken')) {
        expect(h.floor?.rule, h.name).toBe('virtualBalance');
        const floor = h.floor as {pool: string; token: string};
        expect(String(floor.pool)).toBe(poolOf(inventory, m.chainId, m.market));
        expect(underlyings.has(floor.token), h.name).toBe(true);
      }
      expect(m.tokens).toHaveLength(2 * (m.holders.length - 1));
    }
  });

  it('gives each V4 market hubs with a liquidity floor, other holders without one, and the chain V3 oracle', () => {
    expect(v4.map((m) => m.market)).toEqual(['AaveV4Ethereum', 'AaveV4Avalanche']);
    for (const m of v4) {
      expect(m.authority).toBeUndefined();
      expect(m.holders.some((h) => h.role === 'hub')).toBe(true);
      for (const h of m.holders) {
        expect(h.floor, h.name).toEqual(h.role === 'hub' ? {rule: 'hubLiquidity'} : undefined);
      }
      const v3Oracle = v3.find((x) => x.chainId === m.chainId && discoverable(x))!.oracle;
      expect(m.oracle).toBe(v3Oracle);
    }
  });

  it('has no duplicate holder within a market', () => {
    for (const m of inventory.markets) {
      const seen = new Set(m.holders.map((h) => h.address.toLowerCase()));
      expect(seen.size, m.market).toBe(m.holders.length);
    }
  });

  it('includes the regression fixture on Ethereum Core', () => {
    const core = inventory.markets.find((m) => m.chainId === 1 && m.market === 'AaveV3Ethereum')!;
    const aEthUSDC = core.holders.find((h) => h.name === 'aUSDC')!;
    expect(aEthUSDC.address).toBe('0x98C23E9d8f34FEFb1B7BD6a91B7FF122F4e16F5c');
    expect(aEthUSDC.floor).toEqual({
      rule: 'virtualBalance',
      pool: poolOf(inventory, 1, 'AaveV3Ethereum'),
      token: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    });
    expect(core.tokens.find((t) => t.symbol === 'USDC')?.decimals).toBe(6);
    expect(core.authority?.executor).toBe('0x5300A1a15135EA4dc7aD5a167152C01EFc9b192A');
    expect(core.authority?.governedByDao).toBe(true);
  });
});
