import fs from 'fs';
import path from 'path';
import {CHAINS} from './chains';
import {checkSubmodulePin} from './submodule';

const PERMISSIONS_BOOK_DIR = path.resolve(__dirname, '../../lib/aave-permissions-book');
const METADATA_DIR = path.join(PERMISSIONS_BOOK_DIR, 'out/permissions/metadata');

/** The exact permissions-book commit the deployment blocks are read from. Bump deliberately. */
export const PERMISSIONS_BOOK_PIN = {
  repository: 'https://github.com/aave-dao/aave-permissions-book',
  commit: 'a8104bb5dc425256ed8abf36406c4ae54af8483d',
} as const;

export type DeploymentBlock = {
  block: number;
  /** Metadata market key the block came from, e.g. V3 or V3_WHITE_LABEL. */
  market: string;
};

type Metadata = Record<string, {indexedContracts?: Record<string, {deploymentBlock?: number}>}>;

/** Throws unless the submodule is clean and at PERMISSIONS_BOOK_PIN. */
export function checkPermissionsBookPin(): void {
  checkSubmodulePin(PERMISSIONS_BOOK_DIR, 'lib/aave-permissions-book', PERMISSIONS_BOOK_PIN.commit);
}

/**
 * Earliest ACL_MANAGER deployment block across a chain's markets, from the permissions book's
 * generated metadata. The ACL manager is deployed in the same batch as the Pool, at or before it,
 * so this is a safe lower bound for scanning.
 */
export function loadDeploymentBlocks(): Map<number, DeploymentBlock> {
  const blocks = new Map<number, DeploymentBlock>();
  for (const chain of CHAINS) {
    const file = path.join(METADATA_DIR, `${chain.chainId}-metadata.json`);
    if (!fs.existsSync(file)) throw new Error(`${chain.alias}: no permissions-book metadata`);
    const metadata: Metadata = JSON.parse(fs.readFileSync(file, 'utf8'));
    let earliest: DeploymentBlock | undefined;
    for (const [market, data] of Object.entries(metadata)) {
      const block = data.indexedContracts?.ACL_MANAGER?.deploymentBlock;
      if (block === undefined) continue;
      if (!earliest || block < earliest.block) earliest = {block, market};
    }
    if (!earliest) throw new Error(`${chain.alias}: no ACL_MANAGER deployment block in metadata`);
    blocks.set(chain.chainId, earliest);
  }
  return blocks;
}
