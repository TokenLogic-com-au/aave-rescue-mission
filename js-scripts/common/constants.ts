// RPC endpoints for the inherited Merkle scripts (ethers v5) until their viem port.
import {ChainId} from '@aave/contract-helpers';

const JSON_RPC_PROVIDER = {
  [ChainId.mainnet]: `https://eth-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`,
  [ChainId.polygon]: `https://polygon-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`,
  [ChainId.optimism]: `https://opt-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`,
  [ChainId.avalanche]: `https://avax-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`,
};

export {JSON_RPC_PROVIDER};
