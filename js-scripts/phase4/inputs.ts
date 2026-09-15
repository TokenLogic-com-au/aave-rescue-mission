import fs from 'fs';
import {BALANCES_PATH, BalancesManifest} from './balances';
import {canonicalJson, sha256} from './canonical';
import {filterBalances, FILTERED_PATH, FilteredBalances} from './filter';
import {readVerifiedInventory} from './inventory';
import {PINNED_AT} from './policy';
import {parseInstant, RUN_PATH, RunManifest} from './ranges';
import {Inventory} from '../common/types';

/** The upstream files, parsed and as written, so every consumer can check the hash chain. */
export type PipelineInputs = {
  inventory: Inventory;
  inventoryText: string;
  run: RunManifest;
  runText: string;
  balances: BalancesManifest;
  balancesText: string;
  filtered: FilteredBalances;
  filteredText: string;
};

/**
 * filtered -> balances -> run -> inventory must be one unbroken, final chain, built under the
 * current policy: the run pinned at PINNED_AT and the filtered file exactly what filterBalances
 * produces from balances.json today.
 */
export function verifyInputs(inputs: PipelineInputs): void {
  const check = (ok: boolean, what: string) => {
    if (!ok) throw new Error(`inputs do not chain: ${what}`);
  };
  const inventorySha = sha256(inputs.inventoryText);
  check(inputs.run.inventorySha256 === inventorySha, 'run.json was built from another inventory');
  check(
    inputs.run.pinnedAt === parseInstant(PINNED_AT).toISOString(),
    'run.json is not pinned at PINNED_AT'
  );
  check(
    inputs.balances.inventorySha256 === inventorySha,
    'balances.json was built from another inventory'
  );
  check(
    inputs.balances.runSha256 === sha256(inputs.runText),
    'balances.json was built from another run'
  );
  check(
    canonicalJson(inputs.filtered) ===
      canonicalJson(filterBalances(inputs.balances, inputs.balancesText)),
    'filtered file is not what filterBalances produces from balances.json under the current policy'
  );
  if (inputs.run.failures.length) throw new Error('run.json is not final: it has failures');
  if (inputs.balances.failures.length)
    throw new Error('balances.json is not final: it has failures');
}

/** Reads and verifies the chain; the inventory must also equal a fresh build from the pinned address book. */
export function readInputs(): PipelineInputs {
  const inv = readVerifiedInventory();
  const runText = fs.readFileSync(RUN_PATH, 'utf8');
  const balancesText = fs.readFileSync(BALANCES_PATH, 'utf8');
  const filteredText = fs.readFileSync(FILTERED_PATH, 'utf8');
  const inputs: PipelineInputs = {
    inventory: inv.inventory,
    inventoryText: inv.text,
    run: JSON.parse(runText),
    runText,
    balances: JSON.parse(balancesText),
    balancesText,
    filtered: JSON.parse(filteredText),
    filteredText,
  };
  verifyInputs(inputs);
  return inputs;
}
