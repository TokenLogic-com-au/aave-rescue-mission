import fs from 'fs';
import path from 'path';
import {formatUnits, getAddress, type Address, type Hash} from 'viem';
import {sha256, writeCanonical} from './canonical';
import type {AttributionManifest} from './attribution';

export const DECISIONS_PATH = path.resolve(__dirname, 'data/decisions.json');
export const ATTRIBUTION_PATH = path.resolve(__dirname, 'data/attribution.json');

export type DecisionAction = 'pending' | 'approve' | 'reject';

export type DecisionEntry = {
  txHash: Hash;
  chainAlias: string;
  holderSymbol: string;
  tokenSymbol: string;
  amount: string;
  amountFormatted: string;
  tokenFrom: Address;
  txFrom: Address | null;
  txTo: Address | null;
  reason: string;
  /** 'pending': needs human review; 'approve': included in Merkle tree; 'reject': excluded. */
  action: DecisionAction;
  /** Destination address for the rescue. Defaults to tokenFrom, but can be modified by human. */
  beneficiary: Address;
  /** Justification for the decision. */
  notes: string;
};

export type DecisionsManifest = {
  attributionSha256: string;
  decisions: DecisionEntry[];
};

export function buildDecisions(
  attribution: AttributionManifest,
  attributionText: string,
  existingManifest?: DecisionsManifest
): DecisionsManifest {
  const existingMap = new Map<string, DecisionEntry>();
  if (existingManifest?.decisions) {
    for (const d of existingManifest.decisions) {
      existingMap.set(d.txHash.toLowerCase(), d);
    }
  }

  const decisions: DecisionEntry[] = [];

  for (const group of attribution.groups) {
    for (const transfer of group.transfers) {
      if (transfer.outcome !== 'manual_review') continue;

      const existing = existingMap.get(transfer.txHash.toLowerCase());
      if (existing) {
        // Preserve existing human decision, updating formatted fields if necessary
        decisions.push({
          ...existing,
          amountFormatted: `${formatUnits(BigInt(transfer.amount), group.decimals)} ${group.tokenSymbol}`,
        });
      } else {
        decisions.push({
          txHash: transfer.txHash,
          chainAlias: group.chainAlias,
          holderSymbol: group.holderSymbol,
          tokenSymbol: group.tokenSymbol,
          amount: transfer.amount,
          amountFormatted: `${formatUnits(BigInt(transfer.amount), group.decimals)} ${group.tokenSymbol}`,
          tokenFrom: transfer.tokenFrom,
          txFrom: transfer.txFrom,
          txTo: transfer.txTo,
          reason: transfer.reason ?? 'manual review required',
          action: 'pending',
          beneficiary: getAddress(transfer.tokenFrom),
          notes: '',
        });
      }
    }
  }

  // Sort deterministically by chain, token, and txHash
  decisions.sort(
    (a, b) =>
      a.chainAlias.localeCompare(b.chainAlias) ||
      a.tokenSymbol.localeCompare(b.tokenSymbol) ||
      a.txHash.localeCompare(b.txHash)
  );

  return {
    attributionSha256: sha256(attributionText),
    decisions,
  };
}

export function readDecisions(filePath = DECISIONS_PATH): DecisionsManifest | undefined {
  if (!fs.existsSync(filePath)) return undefined;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

export function decisionsByTxHash(
  manifest: DecisionsManifest | undefined = readDecisions()
): Record<string, DecisionEntry> {
  const map: Record<string, DecisionEntry> = {};
  if (!manifest?.decisions) return map;
  for (const d of manifest.decisions) {
    map[d.txHash.toLowerCase()] = d;
  }
  return map;
}

if (require.main === module) {
  if (!fs.existsSync(ATTRIBUTION_PATH)) {
    throw new Error(
      `attribution file not found at ${ATTRIBUTION_PATH}; run phase4:attribution first`
    );
  }
  const attributionText = fs.readFileSync(ATTRIBUTION_PATH, 'utf8');
  const attribution: AttributionManifest = JSON.parse(attributionText);
  const existing = readDecisions();

  const manifest = buildDecisions(attribution, attributionText, existing);
  const digest = writeCanonical(DECISIONS_PATH, manifest);
  const pendingCount = manifest.decisions.filter((d) => d.action === 'pending').length;
  const approvedCount = manifest.decisions.filter((d) => d.action === 'approve').length;
  const rejectedCount = manifest.decisions.filter((d) => d.action === 'reject').length;

  console.log(
    `decisions: ${manifest.decisions.length} total (${approvedCount} approved, ${rejectedCount} rejected, ${pendingCount} pending)`
  );
  console.log(`written to ${path.relative(process.cwd(), DECISIONS_PATH)} (sha256 ${digest})`);
}
