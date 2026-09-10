import {parseBalanceMap} from './parse-balance-map';
import {JSON_RPC_PROVIDER} from '../js-scripts/common/constants';
import {getNetworkName} from './common/helper';
import {getTokenDecimals} from './common/helper';
import {ChainId} from '@aave/contract-helpers';
import {providers} from 'ethers';
import TOKENS_ETH from './assets/ethTokens.json';
import TOKENS_POL from './assets/polTokens.json';
import TOKENS_AVA from './assets/avaTokens.json';
import TOKENS_OPT from './assets/optTokens.json';
import V2_ETH_A_TOKENS from './assets/v2EthATokens.json';
import V1_ETH_A_TOKENS from './assets/v1EthATokens.json';
import V2_POL_A_TOKENS from './assets/v2PolATokens.json';
import ethereumAraiRescueMap from './maps/ethereum/v2_aRaiRescueMap.json';
import ethereumAbtcRescueMap from './maps/ethereum/v1_aWbtcRescueMap.json';
import ethereumUsdtRescueMap from './maps/ethereum/usdtRescueMap.json';
import ethereumDaiRescueMap from './maps/ethereum/daiRescueMap.json';
import ethereumGusdRescueMap from './maps/ethereum/gusdRescueMap.json';
import ethereumLinkRescueMap from './maps/ethereum/linkRescueMap.json';
import ethereumUsdcRescueMap from './maps/ethereum/usdcRescueMap.json';
import polygonAusdcRescueMap from './maps/polygon/v2_ausdcRescueMap.json';
import polygonWbtcRescueMap from './maps/polygon/wbtcRescueMap.json';
import polygonAdaiRescueMap from './maps/polygon/v2_adaiRescueMap.json';
import polygonUsdcRescueMap from './maps/polygon/usdcRescueMap.json';
import avalancheUsdtERescueMap from './maps/avalanche/usdt.eRescueMap.json';
import avalancheUsdcERescueMap from './maps/avalanche/usdc.eRescueMap.json';
import optimismUsdcRescueMap from './maps/optimism/usdcRescueMap.json';
import fs from 'fs';

async function generateMerkleRoot(
  jsonObj: Record<string, {amount: string; txns: string[]; label?: string}>,
  name: string,
  tokenAddress: string,
  network: keyof typeof JSON_RPC_PROVIDER
) {
  const provider = new providers.StaticJsonRpcProvider(JSON_RPC_PROVIDER[network]);
  const decimals = await getTokenDecimals(provider, tokenAddress);
  const networkName = getNetworkName(network);
  const path = `./js-scripts/maps/${networkName}/merkleTree/${name}RescueMerkleTree.json`;
  fs.writeFileSync(
    path,
    JSON.stringify(parseBalanceMap(jsonObj, decimals, `${networkName}_${name}`))
  );
}

generateMerkleRoot(ethereumAraiRescueMap, 'v2_arai', V2_ETH_A_TOKENS.RAI, ChainId.mainnet);
generateMerkleRoot(ethereumAbtcRescueMap, 'v1_awbtc', V1_ETH_A_TOKENS.WBTC, ChainId.mainnet);
generateMerkleRoot(ethereumUsdtRescueMap, 'usdt', TOKENS_ETH.USDT, ChainId.mainnet);
generateMerkleRoot(ethereumDaiRescueMap, 'dai', TOKENS_ETH.DAI, ChainId.mainnet);
generateMerkleRoot(ethereumGusdRescueMap, 'gusd', TOKENS_ETH.GUSD, ChainId.mainnet);
generateMerkleRoot(ethereumLinkRescueMap, 'link', TOKENS_ETH.LINK, ChainId.mainnet);
generateMerkleRoot(ethereumUsdcRescueMap, 'usdc', TOKENS_ETH.USDC, ChainId.mainnet);
generateMerkleRoot(polygonAusdcRescueMap, 'v2_ausdc', V2_POL_A_TOKENS.USDC, ChainId.polygon);
generateMerkleRoot(polygonWbtcRescueMap, 'wbtc', TOKENS_POL.WBTC, ChainId.polygon);
generateMerkleRoot(polygonAdaiRescueMap, 'v2_adai', V2_POL_A_TOKENS.DAI, ChainId.polygon);
generateMerkleRoot(polygonUsdcRescueMap, 'usdc', TOKENS_POL.USDC, ChainId.polygon);
generateMerkleRoot(avalancheUsdtERescueMap, 'usdt.e', TOKENS_AVA['USDT.e'], ChainId.avalanche);
generateMerkleRoot(avalancheUsdcERescueMap, 'usdc.e', TOKENS_AVA['USDC.e'], ChainId.avalanche);
generateMerkleRoot(optimismUsdcRescueMap, 'usdc', TOKENS_OPT.USDC, ChainId.optimism);
