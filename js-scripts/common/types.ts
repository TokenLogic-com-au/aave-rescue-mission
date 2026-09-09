import type {Address} from 'viem';

export type Asset = {
  symbol: string;
  underlying: Address;
  aToken: Address;
  decimals: number;
};

export type Market = {
  /** Address-book module name, e.g. AaveV3Ethereum, AaveV3EthereumLido. */
  market: string;
  chainId: number;
  pool: Address;
  /** Admin of the market's ACL manager: who can grant POOL_ADMIN, hence who governs the market. */
  aclAdmin: Address;
  aclManager: Address;
  /** The market's AaveOracle, used to value holdings at the pinned block. */
  oracle: Address;
  assets: Asset[];
};

export type Provenance = {
  repository: string;
  commit: string;
  tag: string;
};

export type MarketModule = {
  CHAIN_ID?: number;
  POOL?: string;
  ACL_ADMIN?: string;
  ACL_MANAGER?: string;
  ORACLE?: string;
  ASSETS?: Record<string, {UNDERLYING: string; A_TOKEN: string; decimals: number}>;
};

export type GovernanceModule = {CHAIN_ID?: number; EXECUTOR_LVL_1?: string};

export type TargetType = 'pool' | 'aToken';

export type Target = {
  chainId: number;
  chainAlias: string;
  market: string;
  /** The chain's Governance V3 Level 1 executor, the account a DAO payload runs as. */
  executor: Address;
  /** The market's ACL admin from the address book. */
  aclAdmin: Address;
  aclManager: Address;
  oracle: Address;
  /** True when the ACL admin is the DAO executor, i.e. a governance payload can call rescueTokens. */
  governedByDao: boolean;
  targetType: TargetType;
  target: Address;
  /** For aTokens: the reserve underlying. Absent for pools. */
  underlying?: Address;
  symbol?: string;
  decimals?: number;
  /** Address-book module and key the row was derived from. */
  source: string;
};

export type Inventory = {
  addressBook: Provenance;
  targets: Target[];
};
