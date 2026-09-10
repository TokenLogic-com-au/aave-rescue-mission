import {describe, expect, it} from 'vitest';
import {BalancesManifest, Holding} from './balances';
import {canonicalJson, sha256} from './canonical';
import {EXCLUSIONS} from './chains';
import {filterBalances} from './filter';
import {PipelineInputs, verifyInputs} from './inputs';
import {PERMISSIONS_BOOK_PIN} from './permissionsBook';
import {RunManifest} from './ranges';
import {Inventory} from '../common/types';

const holding = (over: Partial<Holding> = {}): Holding => ({
  chainId: 8453,
  chainAlias: 'base',
  market: 'AaveV3Base',
  kind: 'atoken-in-itself',
  holder: '0x0000000000000000000000000000000000000003',
  holderSymbol: 'aUSDC',
  token: '0x0000000000000000000000000000000000000003',
  tokenSymbol: 'aUSDC',
  decimals: 6,
  amount: '1000000',
  amountFormatted: '1',
  priceUsd: '1',
  valueUsd: '1000.00',
  ...over,
});

const inventory: Inventory = {addressBook: {repository: 'x', commit: 'y', tag: 'z'}, targets: []};
const inventoryText = canonicalJson(inventory);
const run: RunManifest = {
  pinnedAt: '2026-09-01T00:00:00.000Z',
  inventorySha256: sha256(inventoryText),
  permissionsBook: {...PERMISSIONS_BOOK_PIN},
  chains: [
    {
      chainId: 8453,
      alias: 'base',
      fromBlock: 100,
      fromBlockSource: 'permissions-book',
      toBlock: 200,
      toBlockTimestamp: 1,
      markets: [],
    },
  ],
  failures: [],
  exclusions: [...EXCLUSIONS],
};
const runText = canonicalJson(run);
const balances: BalancesManifest = {
  runSha256: sha256(runText),
  inventorySha256: sha256(inventoryText),
  chains: [
    {
      chainId: 8453,
      alias: 'base',
      block: 200,
      holdings: [holding(), holding({tokenSymbol: 'DUST', valueUsd: '1.00'})],
    },
  ],
  failures: [],
};
const balancesText = canonicalJson(balances);
const filtered = filterBalances(balances, balancesText);
const inputs = (over: Partial<PipelineInputs> = {}): PipelineInputs => {
  const base = {inventory, inventoryText, run, runText, balances, balancesText, filtered, ...over};
  return {...base, filteredText: canonicalJson(base.filtered)};
};

describe('verifyInputs', () => {
  it('accepts a chain built under the current policy', () => {
    expect(() => verifyInputs(inputs())).not.toThrow();
  });

  it('refuses inputs that do not chain, are not final, or were built under another policy', () => {
    const failedRun = {...run, failures: [{chainId: 1, alias: 'mainnet', reason: 'x'}]};
    const failedBalances = {...balances, failures: [{chainId: 143, alias: 'monad', reason: 'x'}]};
    const cases: [Partial<PipelineInputs>, string][] = [
      [{run: {...run, inventorySha256: 'x'}}, 'another inventory'],
      [{run: {...run, pinnedAt: '2020-01-01T00:00:00.000Z'}}, 'not pinned at PINNED_AT'],
      [{balances: {...balances, inventorySha256: 'x'}}, 'another inventory'],
      [{balances: {...balances, runSha256: 'x'}}, 'another run'],
      [
        {
          run: failedRun,
          runText: canonicalJson(failedRun),
          balances: {...balances, runSha256: sha256(canonicalJson(failedRun))},
        },
        'run.json is not final',
      ],
      [
        {
          balances: failedBalances,
          balancesText: canonicalJson(failedBalances),
          filtered: filterBalances(failedBalances, canonicalJson(failedBalances)),
        },
        'balances.json is not final',
      ],
      [{filtered: {...filtered, balancesSha256: 'x'}}, 'not what filterBalances produces'],
      [
        {
          filtered: {
            ...filtered,
            chains: [{...filtered.chains[0], holdings: [holding({amount: '1000001'})]}],
          },
        },
        'not what filterBalances produces',
      ],
      [
        {
          filtered: {
            ...filtered,
            chains: [{...filtered.chains[0], holdings: [holding(), holding()]}],
          },
        },
        'not what filterBalances produces',
      ],
      [{filtered: {...filtered, chains: []}}, 'not what filterBalances produces'],
      [{filtered: {...filtered, minUsd: 5}}, 'not what filterBalances produces'],
    ];
    for (const [over, message] of cases) expect(() => verifyInputs(inputs(over))).toThrow(message);
  });
});
