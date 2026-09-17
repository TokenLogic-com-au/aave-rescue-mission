import fs from 'fs';
import path from 'path';
import {formatUnits} from 'viem';
import {type SupportedChainId, getNetworkName} from './phase4/chains';
import {getTokenDecimals} from './common/helper';
import {
  PHASE4_DISTRIBUTIONS,
  buildRescueMapsFromAttribution,
  type RescueMap,
} from './generate-merkle-root';

export async function format(
  jsonObj: Record<string, {amount: string; label?: string}>,
  name: string,
  tokenAddress: string,
  network: SupportedChainId
) {
  const newObj: Record<string, string> = {};
  const decimals = await getTokenDecimals(tokenAddress, network);

  Object.keys(jsonObj).forEach((key) => {
    newObj[key] = `${formatUnits(BigInt(jsonObj[key].amount), decimals)} ${name}${
      jsonObj[key].label ? ` ${jsonObj[key].label}` : ''
    }`;
  });

  const networkName = getNetworkName(network);
  const dir = path.resolve(__dirname, `maps/${networkName}/formatted`);
  fs.mkdirSync(dir, {recursive: true});
  const filePath = path.resolve(dir, `${name}RescueMapFormatted.json`);
  fs.writeFileSync(filePath, JSON.stringify(newObj, null, 2) + '\n');
}

export async function formatAll(): Promise<void> {
  const rescueMaps = buildRescueMapsFromAttribution();

  for (const config of PHASE4_DISTRIBUTIONS) {
    const mapPath = path.resolve(
      __dirname,
      `maps/${config.networkName}/${config.name}RescueMap.json`
    );
    const map: RescueMap = fs.existsSync(mapPath)
      ? JSON.parse(fs.readFileSync(mapPath, 'utf8'))
      : rescueMaps[config.key];

    await format(map, config.name, config.tokenAddress, config.chainId as SupportedChainId);
  }
}

if (require.main === module) {
  formatAll().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
