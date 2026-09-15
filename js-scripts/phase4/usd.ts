/** USD arithmetic in integer cents; oracle prices and amounts never touch floats. */

/** "123.45" or "-0.5" as cents; extra decimals are truncated. */
export function parseCents(usd: string): bigint {
  const [whole, frac = ''] = usd.replace('-', '').split('.');
  const cents = BigInt(whole) * 100n + BigInt(frac.padEnd(2, '0').slice(0, 2));
  return usd.startsWith('-') ? -cents : cents;
}

export function formatCents(cents: bigint): string {
  const sign = cents < 0n ? '-' : '';
  const abs = cents < 0n ? -cents : cents;
  return `${sign}${abs / 100n}.${(abs % 100n).toString().padStart(2, '0')}`;
}

/** amount * price / (10^decimals * unit), as a USD string with two decimals. */
export function usdValue(amount: bigint, decimals: number, price: bigint, unit: bigint): string {
  return formatCents((amount * price * 100n) / (10n ** BigInt(decimals) * unit));
}

/** Value of `amount` at a formatted price such as "0.99987654", floored to cents. */
export function transferCents(amount: bigint, decimals: number, priceUsd: string): bigint {
  const [whole, frac = ''] = priceUsd.split('.');
  const price8 = BigInt(whole) * 10n ** 8n + BigInt(frac.padEnd(8, '0').slice(0, 8));
  return (amount * price8 * 100n) / (10n ** BigInt(decimals) * 10n ** 8n);
}

/** `amount / balance` of a USD value, floored to cents. */
export function shareUsd(valueUsd: string, amount: bigint, balance: bigint): string {
  return formatCents((parseCents(valueUsd) * amount) / balance);
}
