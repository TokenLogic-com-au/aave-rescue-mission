import fs from 'fs';
import path from 'path';
import {BALANCES_PATH, BalancesManifest, ChainBalances, Holding} from './balances';
import {sha256, writeCanonical} from './canonical';
import {MIN_GROUP_USD} from './policy';
import {formatCents, parseCents} from './usd';

/**
 * Holdings worth at least MIN_GROUP_USD, plus every holding the oracle could not price, so
 * nothing disappears silently. The input of surplus and attribution.
 */
export const FILTERED_PATH = path.resolve(__dirname, 'data/balances-filtered.json');

export type FilteredBalances = {
  balancesSha256: string;
  minUsd: number;
  chains: ChainBalances[];
  /** Holdings without an oracle price; cannot be compared to the threshold. */
  unpriced: Holding[];
  totalUsd: string;
};

export function filterBalances(manifest: BalancesManifest, text: string): FilteredBalances {
  const min = BigInt(MIN_GROUP_USD * 100);
  const chains: ChainBalances[] = [];
  const unpriced: Holding[] = [];
  let total = 0n;
  for (const c of manifest.chains) {
    const holdings: Holding[] = [];
    for (const h of c.holdings) {
      if (h.valueUsd === undefined) {
        unpriced.push(h);
        continue;
      }
      const cents = parseCents(h.valueUsd);
      if (cents < min) continue;
      total += cents;
      holdings.push(h);
    }
    if (holdings.length) chains.push({...c, holdings});
  }
  return {
    balancesSha256: sha256(text),
    minUsd: MIN_GROUP_USD,
    chains,
    unpriced,
    totalUsd: formatCents(total),
  };
}

if (require.main === module) {
  if (process.argv.length > 2) throw new Error('usage: filter.ts');
  const text = fs.readFileSync(BALANCES_PATH, 'utf8');
  const out = filterBalances(JSON.parse(text), text);
  writeCanonical(FILTERED_PATH, out);
  console.table(
    out.chains.flatMap((c) =>
      c.holdings.map((h) => ({
        chain: c.alias,
        market: h.market,
        holder: h.holderSymbol,
        token: h.tokenSymbol,
        amount: h.amountFormatted,
        usd: h.valueUsd,
        kind: h.kind,
        note: h.note ?? '',
      }))
    )
  );
  console.log(
    `${out.chains.reduce((n, c) => n + c.holdings.length, 0)} holdings >= ${MIN_GROUP_USD} USD, total ${out.totalUsd} USD; ` +
      `${out.unpriced.length} unpriced; written ${path.relative(process.cwd(), FILTERED_PATH)}`
  );
}
