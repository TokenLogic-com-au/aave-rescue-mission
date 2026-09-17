import fs from 'fs';
import path from 'path';
import {PHASE4_DISTRIBUTIONS} from './generate-merkle-root';

export type LightUserInfo = Record<string, Record<string, string>>;

export type UserInfo = {
  tokenAmountInWei: string;
  proof: string[];
  index: number;
  distributionId: number;
  tokenAmount: string;
  chainId: number;
};

export type Claim = {
  index: number;
  amountInWei: string;
  amount: string;
  proof: string[];
};

export type MerkleTree = {
  merkleRoot: string;
  tokenTotal: string;
  tokenTotalInWei: string;
  claims: Record<string, Claim>;
};

export type UsersJson = Record<string, UserInfo[]>;

const getMerkleTreeJson = (filePath: string): MerkleTree => {
  try {
    const file = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(file);
  } catch (error) {
    console.error(new Error(`unable to fetch ${filePath} with error: ${error}`));
    return {merkleRoot: '', tokenTotal: '', tokenTotalInWei: '', claims: {}};
  }
};

export const NETWORKS = Array.from(new Set(PHASE4_DISTRIBUTIONS.map((d) => d.networkName)));
export type NetworkName = string;

export const generateUsersJson = (network: NetworkName): void => {
  const usersJson: UsersJson = {};
  const lightUsersJson: LightUserInfo = {};
  const configs = PHASE4_DISTRIBUTIONS.filter((d) => d.networkName === network);

  for (const config of configs) {
    const treePath = path.resolve(
      __dirname,
      `maps/${network}/merkleTree/${config.name}RescueMerkleTree.json`
    );
    const merkleTreeJson = getMerkleTreeJson(treePath);

    for (const claimer of Object.keys(merkleTreeJson.claims)) {
      if (!usersJson[claimer]) usersJson[claimer] = [];
      if (!lightUsersJson[claimer]) lightUsersJson[claimer] = {};

      const claimerInfo = merkleTreeJson.claims[claimer];
      lightUsersJson[claimer][config.key] = claimerInfo.amount;

      usersJson[claimer].push({
        tokenAmount: claimerInfo.amount,
        tokenAmountInWei: claimerInfo.amountInWei,
        proof: claimerInfo.proof,
        index: claimerInfo.index,
        distributionId: config.distributionId,
        chainId: config.chainId,
      });
    }
  }

  const dir = path.resolve(__dirname, `maps/${network}`);
  fs.mkdirSync(dir, {recursive: true});
  fs.writeFileSync(
    path.resolve(dir, 'usersMerkleTrees.json'),
    JSON.stringify(usersJson, null, 2) + '\n'
  );
  fs.writeFileSync(
    path.resolve(dir, 'usersAmounts.json'),
    JSON.stringify(lightUsersJson, null, 2) + '\n'
  );
};

export const generateCommonJson = (): void => {
  const usersJson: UsersJson = {};
  const lightUsersJson: LightUserInfo = {};

  for (const network of NETWORKS) {
    const configs = PHASE4_DISTRIBUTIONS.filter((d) => d.networkName === network);

    for (const config of configs) {
      const treePath = path.resolve(
        __dirname,
        `maps/${network}/merkleTree/${config.name}RescueMerkleTree.json`
      );
      const merkleTreeJson = getMerkleTreeJson(treePath);

      for (const claimer of Object.keys(merkleTreeJson.claims)) {
        if (!usersJson[claimer]) usersJson[claimer] = [];
        if (!lightUsersJson[claimer]) lightUsersJson[claimer] = {};

        const claimerInfo = merkleTreeJson.claims[claimer];
        lightUsersJson[claimer][config.key] = claimerInfo.amount;

        usersJson[claimer].push({
          tokenAmount: claimerInfo.amount,
          tokenAmountInWei: claimerInfo.amountInWei,
          proof: claimerInfo.proof,
          index: claimerInfo.index,
          distributionId: config.distributionId,
          chainId: config.chainId,
        });
      }
    }
  }

  const dir = path.resolve(__dirname, 'maps');
  fs.mkdirSync(dir, {recursive: true});
  fs.writeFileSync(
    path.resolve(dir, 'usersMerkleTrees.json'),
    JSON.stringify(usersJson, null, 2) + '\n'
  );
  fs.writeFileSync(
    path.resolve(dir, 'usersAmounts.json'),
    JSON.stringify(lightUsersJson, null, 2) + '\n'
  );
};

export const generateAllUsers = (): void => {
  for (const network of NETWORKS) {
    generateUsersJson(network);
  }
  generateCommonJson();
};

if (require.main === module) {
  generateAllUsers();
}
