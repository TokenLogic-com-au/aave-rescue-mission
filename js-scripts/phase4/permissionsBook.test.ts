import {describe, expect, it} from 'vitest';
import {CHAINS, PHASE_2_3_EXECUTION} from './chains';
import {checkPermissionsBookPin, loadDeploymentBlocks} from './permissionsBook';

describe('permissions book', () => {
  it('is pinned to the expected commit', () => {
    expect(() => checkPermissionsBookPin()).not.toThrow();
  });

  it('has a deployment block for every in-scope chain', () => {
    const blocks = loadDeploymentBlocks();
    for (const chain of CHAINS) {
      const d = blocks.get(chain.chainId);
      expect(d, chain.alias).toBeDefined();
      expect(Number.isInteger(d!.block) && d!.block > 0, chain.alias).toBe(true);
    }
  });

  it('matches independently derived Pool creation blocks (never later than them)', () => {
    // Pool creation blocks found by eth_getCode binary search on 2026-09-08, and Monad by receipt.
    const creation: Record<number, number> = {
      56: 33571625,
      100: 30293057,
      143: 81909758,
      146: 7986598,
      196: 54023251,
      324: 43709029,
      1088: 5445224,
      1868: 7004645,
      4326: 6657953,
      5000: 90172818,
      8453: 2357134,
      9745: 489197,
      42161: 7742429,
      42220: 30390070,
      57073: 19954047,
      59144: 12430836,
      534352: 2618764,
    };
    const blocks = loadDeploymentBlocks();
    for (const [chainId, created] of Object.entries(creation)) {
      const book = blocks.get(Number(chainId))!.block;
      expect(book, chainId).toBeLessThanOrEqual(created);
      expect(created - book, chainId).toBeLessThan(12_000_000);
    }
  });

  it('is earlier than the Phase 2&3 execution blocks on the rescued chains', () => {
    const blocks = loadDeploymentBlocks();
    for (const [chainId, executed] of Object.entries(PHASE_2_3_EXECUTION)) {
      expect(blocks.get(Number(chainId))!.block).toBeLessThan(executed.block);
    }
  });
});
