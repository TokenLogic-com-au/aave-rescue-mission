import {erc20Abi, type Address} from 'viem';
import {CHAIN_ID, chainById, type SupportedChainId, getNetworkName} from '../phase4/chains';
import {envChainReaders} from '../phase4/chain';
import {loadMarkets} from '../phase4/addressBook';
import type {Token} from './types';

let tokenIndex: Map<string, Token> | undefined;

function getTokenIndex(): Map<string, Token> {
  if (!tokenIndex) {
    tokenIndex = new Map();
    for (const m of loadMarkets()) {
      for (const t of m.tokens) {
        const key = `${m.chainId}:${t.address.toLowerCase()}`;
        if (!tokenIndex.has(key)) {
          tokenIndex.set(key, t);
        }
      }
    }
  }
  return tokenIndex;
}

/**
 * Resolves a token's metadata from the pinned Aave address book by its address and chain ID.
 */
export function tokenByAddressAndChain(
  tokenAddress: string,
  chainId: number = CHAIN_ID.mainnet
): Token | undefined {
  return getTokenIndex().get(`${chainId}:${tokenAddress.toLowerCase()}`);
}

export const tokenByAddressAdnChain = tokenByAddressAndChain;

export async function getTokenDecimals(
  tokenAddress: string,
  chainId: number = CHAIN_ID.mainnet
): Promise<number> {
  const token = tokenByAddressAndChain(tokenAddress, chainId);
  if (token !== undefined) return token.decimals;

  const chain = chainById(chainId);
  const reader = envChainReaders()(chain);
  if (!reader) throw new Error(`no RPC reader for chain ${chainId} (${chain.alias})`);

  const [decimals] = await reader.read([
    {address: tokenAddress as Address, abi: erc20Abi, functionName: 'decimals'},
  ]);
  if (decimals === undefined) throw new Error(`decimals() reverted for ${tokenAddress}`);
  return Number(decimals);
}

export {getNetworkName};
