import type {Address, Hash} from 'viem';
import {
  MiscAvalanche,
  MiscEthereum,
  MiscOptimism,
  MiscPolygon,
} from '../../lib/aave-address-book/src/ts/AaveAddressBook';

/**
 * Production chains in scope for Phase 4: every chain with an Aave V3 market and a
 * Governance V3 Level 1 executor in the pinned address book. Aliases match foundry.toml
 * and the RPC_* variables in .env.example.
 */
export type ChainConfig = {
  chainId: number;
  alias: string;
  /** Alchemy network slug, used when RPC_<ALIAS> is not set but ALCHEMY_API_KEY is. */
  alchemy: string;
  /** Dune schema holding the chain's raw `logs` table; absent when Dune does not index the chain. */
  dune?: string;
};

export const CHAINS: readonly ChainConfig[] = [
  {chainId: 1, alias: 'mainnet', alchemy: 'eth-mainnet', dune: 'ethereum'},
  {chainId: 10, alias: 'optimism', alchemy: 'opt-mainnet', dune: 'optimism'},
  {chainId: 56, alias: 'bnb', alchemy: 'bnb-mainnet', dune: 'bnb'},
  {chainId: 100, alias: 'gnosis', alchemy: 'gnosis-mainnet', dune: 'gnosis'},
  {chainId: 137, alias: 'polygon', alchemy: 'polygon-mainnet', dune: 'polygon'},
  {chainId: 143, alias: 'monad', alchemy: 'monad-mainnet'},
  {chainId: 146, alias: 'sonic', alchemy: 'sonic-mainnet', dune: 'sonic'},
  {chainId: 196, alias: 'xlayer', alchemy: 'xlayer-mainnet'},
  {chainId: 324, alias: 'zksync', alchemy: 'zksync-mainnet', dune: 'zksync'},
  {chainId: 1088, alias: 'metis', alchemy: 'metis-mainnet'},
  {chainId: 1868, alias: 'soneium', alchemy: 'soneium-mainnet'},
  {chainId: 4326, alias: 'megaeth', alchemy: 'megaeth-mainnet'},
  {chainId: 5000, alias: 'mantle', alchemy: 'mantle-mainnet', dune: 'mantle'},
  {chainId: 8453, alias: 'base', alchemy: 'base-mainnet', dune: 'base'},
  {chainId: 9745, alias: 'plasma', alchemy: 'plasma-mainnet'},
  {chainId: 42161, alias: 'arbitrum', alchemy: 'arb-mainnet', dune: 'arbitrum'},
  {chainId: 42220, alias: 'celo', alchemy: 'celo-mainnet', dune: 'celo'},
  {chainId: 43114, alias: 'avalanche', alchemy: 'avax-mainnet', dune: 'avalanche_c'},
  {chainId: 57073, alias: 'ink', alchemy: 'ink-mainnet'},
  {chainId: 59144, alias: 'linea', alchemy: 'linea-mainnet', dune: 'linea'},
  {chainId: 534352, alias: 'scroll', alchemy: 'scroll-mainnet', dune: 'scroll'},
];

export const CHAIN_IDS: ReadonlySet<number> = new Set(CHAINS.map((c) => c.chainId));

/** Environment variable holding the chain's RPC URL, e.g. RPC_MAINNET. */
export const rpcEnv = (chain: ChainConfig): string => `RPC_${chain.alias.toUpperCase()}`;

/** RPC_<ALIAS> if set, else the Alchemy endpoint built from ALCHEMY_API_KEY, else undefined. */
export function rpcUrl(
  chain: ChainConfig,
  env: NodeJS.ProcessEnv = process.env
): string | undefined {
  const explicit = env[rpcEnv(chain)];
  if (explicit) return explicit;
  const key = env.ALCHEMY_API_KEY;
  return key ? `https://${chain.alchemy}.g.alchemy.com/v2/${key}` : undefined;
}

/** One reader per chain from the environment's RPC URLs; undefined where no URL is configured. */
export function envReaders<R>(
  make: (url: string, chain: ChainConfig) => R,
  env: NodeJS.ProcessEnv = process.env
): (chain: ChainConfig) => R | undefined {
  return (chain) => {
    const url = rpcUrl(chain, env);
    return url ? make(url, chain) : undefined;
  };
}

/** The RPC must serve the chain it is configured for. */
export function assertChainId(actual: number, chain: ChainConfig): void {
  if (actual !== chain.chainId)
    throw new Error(`RPC serves chain ${actual}, expected ${chain.chainId}`);
}

export function chainById(chainId: number): ChainConfig {
  const chain = CHAINS.find((c) => c.chainId === chainId);
  if (!chain) throw new Error(`chain ${chainId} is not in scope`);
  return chain;
}

/**
 * The transaction that executed Phase 2&3 on a chain: it must have emitted `DistributionAdded`
 * from the chain's AaveMerkleDistributor (address from the pinned address book) at `block`.
 */
export type Phase23Execution = {tx: Hash; block: number; distributor: Address};

/**
 * Phase 2&3 execution per chain. Transfers before these blocks were covered by that phase;
 * scanning starts here on these chains. Verified against the receipt before use.
 */
export const PHASE_2_3_EXECUTION: Readonly<Record<number, Phase23Execution>> = {
  1: {
    block: 18195705,
    tx: '0x604a54970ad073dadec1d94ed1e5e993767033f06db2e3fbd80b0066f651311b',
    distributor: MiscEthereum.AAVE_MERKLE_DISTRIBUTOR as Address,
  },
  137: {
    block: 47952151,
    tx: '0x44d51f22e1b34ae3b2d509a7807cd19ab3f12bb9aa21bee815a2fb55a2f8b61d',
    distributor: MiscPolygon.AAVE_MERKLE_DISTRIBUTOR as Address,
  },
  10: {
    block: 110006099,
    tx: '0x30e2400cbf134d6f420331af3eb6952b7d77abd30658190a0b88dfb1d44f991e',
    distributor: MiscOptimism.AAVE_MERKLE_DISTRIBUTOR as Address,
  },
  43114: {
    block: 37188485,
    tx: '0x4d6cdf4ca30a03f389383df8d614eab5d06e9dd319715f7cab5b36b216724678',
    distributor: MiscAvalanche.AAVE_MERKLE_DISTRIBUTOR as Address,
  },
};

/** Out-of-scope items, recorded in run.json so nothing is dropped silently. */
export const EXCLUSIONS: readonly {scope: string; reason: string}[] = [
  {scope: 'Aave V3 Fantom (250)', reason: 'deprecated market, no Governance V3 executor'},
  {scope: 'Aave V3 Harmony (1666600000)', reason: 'deprecated market, no Governance V3 executor'},
  {scope: 'Aave V1 and V2 markets', reason: 'wound down; Phase 4 targets V3 only'},
  {scope: 'Aave V4 hubs', reason: 'not in the address book; separate initiative'},
  {
    scope: 'AaveV3InkWhitelabel (57073)',
    reason:
      'whitelabel market: ACL admin is the permissioned payloads controller executor, not the DAO executor, so a governance payload cannot call rescueTokens',
  },
  {scope: 'testnets', reason: 'not production'},
];
