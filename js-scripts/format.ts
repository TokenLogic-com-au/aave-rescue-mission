import {providers} from 'ethers';
import {JSON_RPC_PROVIDER} from '../js-scripts/common/constants';
import {ChainId} from '@aave/contract-helpers';
import {normalize} from '@aave/math-utils';
import {getTokenDecimals, getNetworkName} from './common/helper';
import TOKENS_ETH from './assets/ethTokens.json';
import TOKENS_POL from './assets/polTokens.json';
import TOKENS_AVA from './assets/avaTokens.json';
import TOKENS_OPT from './assets/optTokens.json';
import V2_POL_A_TOKENS from './assets/v2PolATokens.json';
import V2_ETH_A_TOKENS from './assets/v2EthATokens.json';
import V1_ETH_A_TOKENS from './assets/v1EthATokens.json';
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

async function format(
  jsonObj: Record<string, {amount: string; label?: string}>,
  name: string,
  tokenAddress: string,
  network: keyof typeof JSON_RPC_PROVIDER
) {
  const newObj: Record<string, string> = {};
  const provider = new providers.StaticJsonRpcProvider(JSON_RPC_PROVIDER[network]);
  const decimals = await getTokenDecimals(provider, tokenAddress);

  Object.keys(jsonObj).forEach((key) => {
    newObj[key] = `${normalize(jsonObj[key].amount, decimals)} ${name}${
      jsonObj[key].label ? ` ${jsonObj[key].label}` : ''
    }`;
  });

  const path = `./js-scripts/maps/${getNetworkName(
    network
  )}/formatted/${name}RescueMapFormatted.json`;
  fs.writeFileSync(path, JSON.stringify(newObj, null, 2));
}

format(ethereumAraiRescueMap, 'v2_arai', V2_ETH_A_TOKENS.RAI, ChainId.mainnet);
format(ethereumAbtcRescueMap, 'v1_abtc', V1_ETH_A_TOKENS.WBTC, ChainId.mainnet);
format(ethereumUsdtRescueMap, 'usdt', TOKENS_ETH.USDT, ChainId.mainnet);
format(ethereumDaiRescueMap, 'dai', TOKENS_ETH.DAI, ChainId.mainnet);
format(ethereumGusdRescueMap, 'gusd', TOKENS_ETH.GUSD, ChainId.mainnet);
format(ethereumLinkRescueMap, 'link', TOKENS_ETH.LINK, ChainId.mainnet);
format(ethereumUsdcRescueMap, 'usdc', TOKENS_ETH.USDC, ChainId.mainnet);
format(polygonAusdcRescueMap, 'v2_ausdc', V2_POL_A_TOKENS.USDC, ChainId.polygon);
format(polygonWbtcRescueMap, 'wbtc', TOKENS_POL.WBTC, ChainId.polygon);
format(polygonAdaiRescueMap, 'v2_adai', V2_POL_A_TOKENS.DAI, ChainId.polygon);
format(polygonUsdcRescueMap, 'usdc', TOKENS_POL.USDC, ChainId.polygon);
format(avalancheUsdtERescueMap, 'usdt.e', TOKENS_AVA['USDT.e'], ChainId.avalanche);
format(avalancheUsdcERescueMap, 'usdc.e', TOKENS_AVA['USDC.e'], ChainId.avalanche);
format(optimismUsdcRescueMap, 'usdc', TOKENS_OPT.USDC, ChainId.optimism);
