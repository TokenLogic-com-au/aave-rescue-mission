import {describe, expect, it} from 'vitest';
import {BalancesManifest, Holding} from './balances';
import {canonicalJson, sha256} from './canonical';
import {filterBalances} from './filter';

const holding = (over: Partial<Holding>): Holding => ({
  chainId: 8453,
  chainAlias: 'base',
  market: 'AaveV3Base',
  kind: 'market-token-in-pool',
  holder: '0x0000000000000000000000000000000000000001',
  holderSymbol: 'Pool',
  token: '0x0000000000000000000000000000000000000002',
  tokenSymbol: 'USDC',
  decimals: 6,
  amount: '1',
  amountFormatted: '0.000001',
  ...over,
});

const manifest: BalancesManifest = {
  runSha256: 'r',
  inventorySha256: 'i',
  chains: [
    {
      chainId: 8453,
      alias: 'base',
      block: 100,
      holdings: [
        holding({valueUsd: '999.99'}),
        holding({valueUsd: '1000.00', tokenSymbol: 'A'}),
        holding({valueUsd: '25000.50', tokenSymbol: 'B'}),
        holding({tokenSymbol: 'NOPRICE'}),
        holding({valueUsd: '-5.00', tokenSymbol: 'NEG'}),
      ],
    },
    {chainId: 1, alias: 'mainnet', block: 5, holdings: [holding({valueUsd: '1.00'})]},
  ],
  failures: [],
};

describe('filterBalances', () => {
  it('keeps holdings at or above the threshold, drops chains left empty, and lists unpriced ones', () => {
    const text = canonicalJson(manifest);
    const out = filterBalances(manifest, text);
    expect(out.balancesSha256).toBe(sha256(text));
    expect(out.chains.map((c) => c.alias)).toEqual(['base']);
    expect(out.chains[0].holdings.map((h) => h.tokenSymbol)).toEqual(['A', 'B']);
    expect(out.unpriced.map((h) => h.tokenSymbol)).toEqual(['NOPRICE']);
    expect(out.totalUsd).toBe('26000.50');
  });

  it('records the policy threshold it applied', () => {
    expect(filterBalances(manifest, canonicalJson(manifest)).minUsd).toBe(1000);
  });
});
