// Remaining helpers for the inherited Merkle scripts (ethers v5) until their viem port.
import {ChainId} from '@aave/contract-helpers';
import {ethers, BigNumber, providers} from 'ethers';
import {JSON_RPC_PROVIDER} from './constants';

export async function getTokenDecimals(
  provider: providers.StaticJsonRpcProvider,
  tokenAddress: string
): Promise<number> {
  const tokenAbi = ['function decimals() view returns (uint256)'];
  const tokenContract = new ethers.Contract(tokenAddress, tokenAbi, provider);
  const data: BigNumber = await tokenContract.decimals();
  return data.toNumber();
}

export function getNetworkName(network: keyof typeof JSON_RPC_PROVIDER): string {
  if (network == ChainId.mainnet) return 'ethereum';
  if (network == ChainId.polygon) return 'polygon';
  if (network == ChainId.optimism) return 'optimism';
  if (network == ChainId.avalanche) return 'avalanche';
  throw Error('Invalid network');
}
