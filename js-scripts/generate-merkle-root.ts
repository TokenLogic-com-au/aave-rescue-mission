import fs from 'fs';
import path from 'path';
import {getAddress} from 'viem';
import {parseBalanceMap} from './parse-balance-map';
import {
  CHAIN_ID,
  chainById,
  type ChainConfig,
  type SupportedChainId,
  getNetworkName,
} from './phase4/chains';
import {getTokenDecimals} from './common/helper';
import {
  AaveV3Arbitrum,
  AaveV3BNB,
  AaveV3Ethereum,
  AaveV3Polygon,
} from '../lib/aave-address-book/src/ts/AaveAddressBook';

export type Phase4DistributionInput = {
  key: string;
  chainId: number;
  holderSymbol: string;
  tokenSymbol: string;
  tokenAddress: string;
  decimals: number;
  name: string;
  distributionId: number;
};

export type Phase4DistributionConfig = Phase4DistributionInput & {
  chain: ChainConfig;
  chainAlias: string;
  networkName: string;
};

function dist(input: Phase4DistributionInput): Phase4DistributionConfig {
  const chain = chainById(input.chainId);
  return {
    ...input,
    chain,
    chainAlias: chain.alias,
    networkName: chain.networkName,
  };
}

export const PHASE4_DISTRIBUTIONS: Phase4DistributionConfig[] = [
  // Ethereum (starts at distributionId 11 after Phase 1-3)
  dist({
    key: 'ETH_USDT',
    chainId: CHAIN_ID.mainnet,
    holderSymbol: 'aUSDT',
    tokenSymbol: 'USDT',
    tokenAddress: AaveV3Ethereum.ASSETS.USDT.UNDERLYING,
    decimals: AaveV3Ethereum.ASSETS.USDT.decimals,
    name: 'usdt',
    distributionId: 11,
  }),
  dist({
    key: 'ETH_AUSDC',
    chainId: CHAIN_ID.mainnet,
    holderSymbol: 'aUSDC',
    tokenSymbol: 'aUSDC',
    tokenAddress: AaveV3Ethereum.ASSETS.USDC.A_TOKEN,
    decimals: AaveV3Ethereum.ASSETS.USDC.decimals,
    name: 'ausdc',
    distributionId: 12,
  }),
  dist({
    key: 'ETH_USDC',
    chainId: CHAIN_ID.mainnet,
    holderSymbol: 'aUSDC',
    tokenSymbol: 'USDC',
    tokenAddress: AaveV3Ethereum.ASSETS.USDC.UNDERLYING,
    decimals: AaveV3Ethereum.ASSETS.USDC.decimals,
    name: 'usdc',
    distributionId: 13,
  }),
  // BNB (starts at distributionId 0 on newly deployed distributor)
  dist({
    key: 'BNB_USDC',
    chainId: CHAIN_ID.bnb,
    holderSymbol: 'aUSDC',
    tokenSymbol: 'USDC',
    tokenAddress: AaveV3BNB.ASSETS.USDC.UNDERLYING,
    decimals: AaveV3BNB.ASSETS.USDC.decimals,
    name: 'usdc',
    distributionId: 0,
  }),
  dist({
    key: 'BNB_USDT',
    chainId: CHAIN_ID.bnb,
    holderSymbol: 'aUSDT',
    tokenSymbol: 'USDT',
    tokenAddress: AaveV3BNB.ASSETS.USDT.UNDERLYING,
    decimals: AaveV3BNB.ASSETS.USDT.decimals,
    name: 'usdt',
    distributionId: 1,
  }),
  // Polygon (starts at distributionId 4 after Phase 2&3)
  dist({
    key: 'POL_USDT0',
    chainId: CHAIN_ID.polygon,
    holderSymbol: 'aUSDT0',
    tokenSymbol: 'USDT0',
    tokenAddress: AaveV3Polygon.ASSETS.USDT0.UNDERLYING,
    decimals: AaveV3Polygon.ASSETS.USDT0.decimals,
    name: 'usdt0',
    distributionId: 4,
  }),
  dist({
    key: 'POL_USDCN',
    chainId: CHAIN_ID.polygon,
    holderSymbol: 'Pool',
    tokenSymbol: 'USDCn',
    tokenAddress: AaveV3Polygon.ASSETS.USDCn.UNDERLYING,
    decimals: AaveV3Polygon.ASSETS.USDCn.decimals,
    name: 'usdcn',
    distributionId: 5,
  }),
  // Arbitrum (starts at distributionId 0 on newly deployed distributor)
  dist({
    key: 'ARB_WBTC',
    chainId: CHAIN_ID.arbitrum,
    holderSymbol: 'aWBTC',
    tokenSymbol: 'WBTC',
    tokenAddress: AaveV3Arbitrum.ASSETS.WBTC.UNDERLYING,
    decimals: AaveV3Arbitrum.ASSETS.WBTC.decimals,
    name: 'wbtc',
    distributionId: 0,
  }),
  dist({
    key: 'ARB_USDCN',
    chainId: CHAIN_ID.arbitrum,
    holderSymbol: 'Pool',
    tokenSymbol: 'USDCn',
    tokenAddress: AaveV3Arbitrum.ASSETS.USDCn.UNDERLYING,
    decimals: AaveV3Arbitrum.ASSETS.USDCn.decimals,
    name: 'usdcn',
    distributionId: 1,
  }),
];

export type RescueMapEntry = {
  amount: string;
  txns: string[];
  label?: string;
};

export type RescueMap = Record<string, RescueMapEntry>;

const ATTRIBUTION_PATH = path.resolve(__dirname, 'phase4/data/attribution.json');

export function readAttributionJson(filePath = ATTRIBUTION_PATH) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`attribution.json not found at ${filePath}`);
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

export function buildRescueMapsFromAttribution(
  attributionData = readAttributionJson()
): Record<string, RescueMap> {
  const result: Record<string, RescueMap> = {};

  for (const config of PHASE4_DISTRIBUTIONS) {
    const group = attributionData.groups.find(
      (g: any) =>
        g.chainAlias === config.chainAlias &&
        g.tokenSymbol === config.tokenSymbol &&
        g.holderSymbol === config.holderSymbol
    );

    if (!group) {
      throw new Error(
        `Group not found for ${config.chainAlias} ${config.holderSymbol} ${config.tokenSymbol}`
      );
    }

    if (getAddress(group.token) !== getAddress(config.tokenAddress)) {
      throw new Error(
        `Token address mismatch for ${config.key}: address book has ${config.tokenAddress}, attribution has ${group.token}`
      );
    }

    const map: RescueMap = {};
    for (const transfer of group.transfers) {
      if (transfer.outcome !== 'candidate') continue;
      const account = getAddress(transfer.tokenFrom);
      if (!map[account]) {
        map[account] = {amount: '0', txns: []};
      }
      map[account].amount = (BigInt(map[account].amount) + BigInt(transfer.amount)).toString();
      if (!map[account].txns.includes(transfer.txHash)) {
        map[account].txns.push(transfer.txHash);
      }
    }

    // Sort accounts deterministically
    const sortedMap: RescueMap = {};
    for (const key of Object.keys(map).sort((a, b) => a.localeCompare(b))) {
      sortedMap[key] = {
        amount: map[key].amount,
        txns: map[key].txns.sort(),
      };
    }

    result[config.key] = sortedMap;
  }

  return result;
}

export function writeRescueMaps(rescueMaps = buildRescueMapsFromAttribution()): void {
  for (const config of PHASE4_DISTRIBUTIONS) {
    const map = rescueMaps[config.key];
    if (!map) continue;
    const dir = path.resolve(__dirname, `maps/${config.networkName}`);
    fs.mkdirSync(dir, {recursive: true});
    fs.writeFileSync(
      path.resolve(dir, `${config.name}RescueMap.json`),
      JSON.stringify(map, null, 2) + '\n'
    );
  }
}

export async function generateMerkleRoot(
  jsonObj: Record<string, {amount: string; txns: string[]; label?: string}>,
  name: string,
  tokenAddress: string,
  network: SupportedChainId
) {
  const decimals = await getTokenDecimals(tokenAddress, network);
  const networkName = getNetworkName(network);
  const dir = path.resolve(__dirname, `maps/${networkName}/merkleTree`);
  fs.mkdirSync(dir, {recursive: true});
  const filePath = path.resolve(dir, `${name}RescueMerkleTree.json`);
  fs.writeFileSync(
    filePath,
    JSON.stringify(parseBalanceMap(jsonObj, decimals, `${networkName}_${name}`), null, 2) + '\n'
  );
}

export async function generateAllMerkleRoots(): Promise<void> {
  const rescueMaps = buildRescueMapsFromAttribution();
  writeRescueMaps(rescueMaps);

  for (const config of PHASE4_DISTRIBUTIONS) {
    const map = rescueMaps[config.key];
    await generateMerkleRoot(
      map,
      config.name,
      config.tokenAddress,
      config.chainId as SupportedChainId
    );
  }
}

if (require.main === module) {
  generateAllMerkleRoots().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
