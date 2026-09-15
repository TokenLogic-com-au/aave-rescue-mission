import type {Address} from 'viem';

export type Provenance = {
  repository: string;
  commit: string;
  tag: string;
};

/** Shape of an address-book AaveV3* module, as far as discovery needs it. */
export type MarketModule = {
  CHAIN_ID?: number;
  POOL?: string;
  ACL_ADMIN?: string;
  ACL_MANAGER?: string;
  ORACLE?: string;
  ASSETS?: Record<string, {UNDERLYING: string; A_TOKEN: string; decimals: number}>;
};

export type GovernanceModule = {CHAIN_ID?: number; EXECUTOR_LVL_1?: string};

/** Shape of an address-book AaveV4* module, as far as discovery needs it. */
export type V4Module = {
  CHAIN_ID?: number;
  HUBS?: Record<string, string>;
  SPOKES?: Record<string, string>;
  TOKENIZATION_SPOKES?: Record<string, string>;
  POSITION_MANAGERS?: Record<string, string>;
  ASSETS?: Record<string, {UNDERLYING: string; decimals: number}>;
};

export type Protocol = 'v3' | 'v4';

export type HolderRole =
  'pool' | 'aToken' | 'hub' | 'spoke' | 'tokenizationSpoke' | 'positionManager';

/**
 * How the protocol tracks what a holder legitimately holds; anything above the floor is stuck.
 * An aToken holds its own underlying up to `Pool.getVirtualUnderlyingBalance`; a hub holds each
 * asset it lists up to `getAssetLiquidity`. A holder without a floor legitimately holds nothing.
 */
export type Floor =
  {rule: 'virtualBalance'; pool: Address; token: Address} | {rule: 'hubLiquidity'};

/** A protocol contract that may end up holding tokens. */
export type Holder = {
  name: string;
  address: Address;
  role: HolderRole;
  floor?: Floor;
  /** Address-book module and key the row was derived from. */
  source: string;
};

/** A token the market deals in, and which token's oracle price values it (an aToken is priced by its underlying). */
export type Token = {
  address: Address;
  symbol: string;
  decimals: number;
  pricedBy: Address;
  source: string;
};

/** Who can call rescueTokens on a V3 market: the DAO executor, if it is the market's ACL admin. */
export type Authority = {
  executor: Address;
  aclAdmin: Address;
  aclManager: Address;
  governedByDao: boolean;
};

export type Market = {
  /** Address-book module name, e.g. AaveV3Ethereum, AaveV4Ethereum. */
  market: string;
  protocol: Protocol;
  chainId: number;
  chainAlias: string;
  /** AaveOracle used to value the market's tokens; V4 markets borrow the chain's V3 oracle. */
  oracle?: Address;
  /** Absent for V4: discovery only, no rescue path is defined for it yet. */
  authority?: Authority;
  holders: Holder[];
  tokens: Token[];
};

export type Inventory = {
  addressBook: Provenance;
  markets: Market[];
};
