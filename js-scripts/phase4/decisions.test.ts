import {describe, expect, it} from 'vitest';
import {getAddress, type Address, type Hash} from 'viem';
import {
  buildDecisions,
  decisionsByTxHash,
  type DecisionsManifest,
  type DecisionEntry,
} from './decisions';
import type {AttributionManifest, Group} from './attribution';
import {
  assertDecisionsIntegrity,
  buildRescueMapsFromAttribution,
  PHASE4_DISTRIBUTIONS,
} from '../generate-merkle-root';

function makeGroup(overrides: Partial<Group> = {}): Group {
  return {
    chainId: 1,
    chainAlias: 'mainnet',
    market: 'AaveV3Ethereum',
    kind: 'underlying-in-own-atoken',
    holder: '0x71fc860F7D3A592A4a99170dEAE3013242646380' as Address,
    holderSymbol: 'aUSDT',
    token: '0xdAC17F958D2ee523a2206206994597C13D831ec7' as Address,
    tokenSymbol: 'USDT',
    decimals: 6,
    fromBlock: 100,
    toBlock: 200,
    balance: '1000000',
    evidence: {source: 'rpc-logs'},
    transfers: [],
    wallets: [],
    outflows: [],
    reconciliation: {
      candidates: '0',
      review: '0',
      dust: '0',
      outflows: '0',
      delta: '0',
      status: 'reconciled',
    },
    ...overrides,
  };
}

describe('decisions', () => {
  const dummyTx1 = '0x1111111111111111111111111111111111111111111111111111111111111111' as Hash;
  const dummyTx2 = '0x2222222222222222222222222222222222222222222222222222222222222222' as Hash;
  const sender1 = '0x35e6235747e9bEA0a0963b00a55a5f5D1cfA221D' as Address;
  const sender2 = '0x949954b50B5780d3A1c54deB7Cbb0dbcc558861B' as Address;

  const attribution: AttributionManifest = {
    filteredSha256: 'fil',
    runSha256: 'run',
    minTransferUsd: 1,
    groups: [
      makeGroup({
        transfers: [
          {
            block: 101,
            txHash: dummyTx1,
            logIndex: 1,
            tokenFrom: sender1,
            txFrom: null,
            txTo: null,
            amount: '5000000',
            outcome: 'manual_review',
            reason: 'sender is not the transaction signer',
          },
          {
            block: 102,
            txHash: dummyTx2,
            logIndex: 2,
            tokenFrom: sender2,
            txFrom: null,
            txTo: null,
            amount: '1000000',
            outcome: 'candidate',
          },
        ],
      }),
    ],
    deferred: [],
    failures: [],
  };

  it('extracts manual_review transfers into pending decisions', () => {
    const manifest = buildDecisions(attribution, JSON.stringify(attribution));
    expect(manifest.decisions.length).toBe(1);
    const d = manifest.decisions[0];
    expect(d.txHash).toBe(dummyTx1);
    expect(d.action).toBe('pending');
    expect(d.beneficiary).toBe(getAddress(sender1));
    expect(d.amount).toBe('5000000');
    expect(d.amountFormatted).toBe('5 USDT');
    expect(manifest.attributionSha256).toBeDefined();
  });

  it('preserves existing human decisions across runs', () => {
    const existing: DecisionsManifest = {
      attributionSha256: 'old',
      decisions: [
        {
          txHash: dummyTx1,
          chainAlias: 'mainnet',
          holderSymbol: 'aUSDT',
          tokenSymbol: 'USDT',
          amount: '5000000',
          amountFormatted: '5 USDT',
          tokenFrom: sender1,
          txFrom: null,
          txTo: null,
          reason: 'sender is not the transaction signer',
          action: 'approve',
          beneficiary: '0x0000000000000000000000000000000000000002' as Address,
          notes: 'approved via Safe owner verification',
        },
      ],
    };

    const manifest = buildDecisions(attribution, JSON.stringify(attribution), existing);
    expect(manifest.decisions.length).toBe(1);
    const d = manifest.decisions[0];
    expect(d.action).toBe('approve');
    expect(d.beneficiary).toBe('0x0000000000000000000000000000000000000002');
    expect(d.notes).toBe('approved via Safe owner verification');
  });

  it('buildRescueMapsFromAttribution strictly requires decisions and handles approve/reject', () => {
    const pendingDecision: DecisionEntry = {
      txHash: dummyTx1,
      chainAlias: 'mainnet',
      holderSymbol: 'aUSDT',
      tokenSymbol: 'USDT',
      amount: '5000000',
      amountFormatted: '5 USDT',
      tokenFrom: sender1,
      txFrom: null,
      txTo: null,
      reason: 'test',
      action: 'pending',
      beneficiary: sender1,
      notes: '',
    };

    const ethUsdtDist = [PHASE4_DISTRIBUTIONS.find((d) => d.key === 'ETH_USDT')!];

    // 1. Missing decision -> throws error
    expect(() =>
      buildRescueMapsFromAttribution({groups: attribution.groups} as any, {}, ethUsdtDist)
    ).toThrowError(/Missing decision/);

    // 2. Pending decision -> throws error (never silent)
    expect(() =>
      buildRescueMapsFromAttribution(
        {groups: attribution.groups} as any,
        {[dummyTx1.toLowerCase()]: pendingDecision},
        ethUsdtDist
      )
    ).toThrowError(/is still 'pending'/);

    // 3. Amount mismatch -> throws error
    expect(() =>
      buildRescueMapsFromAttribution(
        {groups: attribution.groups} as any,
        {
          [dummyTx1.toLowerCase()]: {
            ...pendingDecision,
            action: 'approve',
            amount: '9999999',
          },
        },
        ethUsdtDist
      )
    ).toThrowError(/Amount mismatch/);

    // 4. Invalid beneficiary -> throws error
    expect(() =>
      buildRescueMapsFromAttribution(
        {groups: attribution.groups} as any,
        {
          [dummyTx1.toLowerCase()]: {
            ...pendingDecision,
            action: 'approve',
            beneficiary: '0x0000000000000000000000000000000000000000' as Address,
          },
        },
        ethUsdtDist
      )
    ).toThrowError(/Invalid beneficiary/);

    // 5. Rejected decision -> excluded from map with loud console warning (not silent)
    const rejectedDecision: DecisionEntry = {
      ...pendingDecision,
      action: 'reject',
      notes: 'Sender confirmed as arbitrary contract, not the victim',
    };
    const rejectedMaps = buildRescueMapsFromAttribution(
      {groups: attribution.groups} as any,
      {[dummyTx1.toLowerCase()]: rejectedDecision},
      ethUsdtDist
    );
    expect(rejectedMaps['ETH_USDT'][getAddress(sender1)]).toBeUndefined();
    expect(rejectedMaps['ETH_USDT'][getAddress(sender2)].amount).toBe('1000000');

    // 6. Approved decision -> dummyTx1 is credited to beneficiary
    const approvedDecision: DecisionEntry = {
      ...pendingDecision,
      action: 'approve',
      beneficiary: sender1,
    };
    const approvedMaps = buildRescueMapsFromAttribution(
      {groups: attribution.groups} as any,
      {[dummyTx1.toLowerCase()]: approvedDecision},
      ethUsdtDist
    );
    expect(approvedMaps['ETH_USDT'][getAddress(sender1)].amount).toBe('5000000');
    expect(approvedMaps['ETH_USDT'][getAddress(sender2)].amount).toBe('1000000');
  });

  it('assertDecisionsIntegrity strictly verifies presence and attributionSha256 hash match', () => {
    // Missing manifest throws
    expect(() => assertDecisionsIntegrity('sample text', null)).toThrowError(
      /decisions.json not found/
    );

    // Stale hash throws
    expect(() =>
      assertDecisionsIntegrity('sample text', {
        attributionSha256: 'stale-hash',
        decisions: [],
      })
    ).toThrowError(/decisions.json is stale/);
  });
});
