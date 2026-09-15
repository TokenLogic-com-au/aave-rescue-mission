/**
 * Phase 4 policy values, fixed here so every run is the same run. Change them only with a
 * new pinned instant, and expect every data file downstream of the change to be regenerated.
 */

/** The instant the balances are measured at (ISO-8601 UTC); each chain's toBlock is the last block at or before it. */
export const PINNED_AT = '2026-09-01T00:00:00Z';

/** A holding (one token in one holder) below this USD value is out of scope for attribution. */
export const MIN_GROUP_USD = 1000;
