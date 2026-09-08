import 'dotenv';
import fs from 'fs';
import {ethers, providers} from 'ethers';
import {AddressesProviderAbi} from './abis/AddressesProvider.json';
import {WEthGatewayAbi} from './abis/WEthGateway.json';
import V2LendingPool from '../../out/protocol/lendingpool/LendingPool.sol/LendingPool.json';
import AvaRescueMissionPayload from '../../out/AvaRescueMissionPayload.sol/AvaRescueMissionPayload.json';
import AaveMerkleDistributor from '../../out/AaveMerkleDistributor.sol/AaveMerkleDistributor.json';

const TENDERLY_FORK_URL = process.env.TENDERLY_FORK_URL_AVALANCHE;
if (!TENDERLY_FORK_URL) throw new Error('missing TENDERLY_FORK_URL_AVALANCHE');

type Info = {
  tokenAmount: string;
  tokenAmountInWei: string;
  proof: string[];
  index: number;
  distributionId: number;
};

type TokenClaim = {
  index: number;
  account: string;
  amount: string;
  merkleProof: string[];
  distributionId: number;
};

type UsersMerkleTrees = Record<string, Info[]>;

const getMerkleTreeJson = (path: string): UsersMerkleTrees => {
  try {
    const file = fs.readFileSync(path);
    // @ts-ignore
    return JSON.parse(file);
  } catch (error) {
    console.error(new Error(`unable to fetch ${path} with error: ${error}`));
    return {} as UsersMerkleTrees;
  }
};

function linkLibraries(
  {
    bytecode,
    linkReferences,
  }: {
    bytecode: string;
    linkReferences: {
      [fileName: string]: {[contractName: string]: {length: number; start: number}[]};
    };
  },
  libraries: {[libraryName: string]: string}
): string {
  Object.keys(linkReferences).forEach((fileName) => {
    Object.keys(linkReferences[fileName]).forEach((contractName) => {
      if (!libraries.hasOwnProperty(contractName)) {
        throw new Error(`Missing link library name ${contractName}`);
      }
      const address = ethers.utils.getAddress(libraries[contractName]).toLowerCase().slice(2);
      linkReferences[fileName][contractName].forEach(({start: byteStart, length: byteLength}) => {
        const start = 2 + byteStart * 2;
        const length = byteLength * 2;
        bytecode = bytecode
          .slice(0, start)
          .concat(address)
          .concat(bytecode.slice(start + length, bytecode.length));
      });
    });
  });
  return bytecode;
}

const provider = new providers.StaticJsonRpcProvider(TENDERLY_FORK_URL);

const DEPLOYER = '0x25F2226B597E8F9514B3F68F00f494cF4f286491';
const POOL_ADDRESSES_PROVIDER = '0xb6A86025F0FE1862B372cb0ca18CE3EDe02A318f';
// const OWNER = '0x01244E7842254e3FD229CD263472076B1439D1Cd'; // owner of addresses provider
const ADDRESSES_PROVIDER_OWNER = '0xa35b76e4935449e33c56ab24b23fcd3246f13470';
const WETH_GATEWAY_OWNER = '0x01244E7842254e3FD229CD263472076B1439D1Cd';
const WETH_GATEWAY = '0x8a47f74d1ee0e2edeb4f3a7e64ef3bd8e11d27c8';

const giveEth = async (addresses: string[]) => {
  await provider.send('tenderly_addBalance', [
    addresses,
    //amount in wei will be added for all wallets
    ethers.utils.hexValue(ethers.utils.parseUnits('1000', 'ether').toHexString()),
  ]);
};

const deploy = async () => {
  await giveEth([DEPLOYER]);

  //---------------------------------------------------------------------------------------------------------------------------------
  //                                    DEPLOY DEPENDENCY CONTRACTS: MERKLE DISTRIBUTOR, V2_POOL
  //---------------------------------------------------------------------------------------------------------------------------------

  // deploy merkle distributor
  const merkleDistributorFactory = new ethers.ContractFactory(
    AaveMerkleDistributor.abi,
    AaveMerkleDistributor.bytecode,
    provider.getSigner(DEPLOYER)
  );
  const merkleDistributorContract = await merkleDistributorFactory.deploy();
  console.log(`[MerkleDistributor]: ${merkleDistributorContract.address}`);

  // deploy v2 pool and manually link the libraries
  const reserveLogic = '0x4ce2024e585c60562b0abd7a943c0bb243be5914';
  const validationLogic = '0x35639e90cdd8835d065750b36cf4a26418658e3e';
  const v2PoolFactory = new ethers.ContractFactory(
    V2LendingPool.abi,
    linkLibraries(
      {
        bytecode: V2LendingPool.bytecode.object,
        linkReferences: V2LendingPool.bytecode.linkReferences,
      },
      {
        ReserveLogic: reserveLogic,
        ValidationLogic: validationLogic,
      }
    ),
    provider.getSigner(DEPLOYER)
  );
  const v2PoolContract = await v2PoolFactory.deploy();
  console.log(`[AaveV2LendingPoolImpl]: ${v2PoolContract.address}`);

  //---------------------------------------------------------------------------------------------------------------------------------
  //                                                      DEPLOY PAYLOAD
  //---------------------------------------------------------------------------------------------------------------------------------

  const payload_Factory = new ethers.ContractFactory(
    AvaRescueMissionPayload.abi,
    AvaRescueMissionPayload.bytecode,
    provider.getSigner(DEPLOYER)
  );
  const payload_Contract = await payload_Factory.deploy(
    merkleDistributorContract.address,
    v2PoolContract.address
  );
  console.log(`[Payload]: ${payload_Contract.address}`);

  //---------------------------------------------------------------------------------------------------------------------------------
  //                                                      EXECUTE PAYLOAD
  //---------------------------------------------------------------------------------------------------------------------------------

  // transferring permission to execute the payload as its difficult to simulate delegate-call via the multi-sig
  const transferTx = await merkleDistributorContract.transferOwnership(payload_Contract.address);
  await transferTx.wait();

  const addressesProvider = new ethers.Contract(
    POOL_ADDRESSES_PROVIDER,
    AddressesProviderAbi,
    provider.getSigner(ADDRESSES_PROVIDER_OWNER)
  );
  await addressesProvider.setPoolAdmin(payload_Contract.address);
  await addressesProvider.transferOwnership(payload_Contract.address);

  const wethGateway = new ethers.Contract(
    WETH_GATEWAY,
    WEthGatewayAbi,
    provider.getSigner(WETH_GATEWAY_OWNER)
  );
  await wethGateway.transferOwnership(payload_Contract.address);

  // execute payloads
  await payload_Contract.execute();
  console.log('Payload executed');

  return {
    provider,
    merkleDistributor: merkleDistributorContract.address,
  };
};

const testAvalancheClaims = async () => {
  const {provider, merkleDistributor} = await deploy();
  const claims = getMerkleTreeJson('./js-scripts/maps/avalanche/usersMerkleTrees.json');

  for (const account of Object.keys(claims)) {
    const merkleDistributorContract = new ethers.Contract(
      merkleDistributor,
      AaveMerkleDistributor.abi,
      provider.getSigner(account)
    );

    await giveEth([account]);

    const tokensToClaim: TokenClaim[] = [];
    claims[account].forEach((tokenInfo: Info) => {
      tokensToClaim.push({
        index: tokenInfo.index,
        account,
        amount: tokenInfo.tokenAmountInWei,
        merkleProof: tokenInfo.proof,
        distributionId: tokenInfo.distributionId,
      });
    });

    const claimTx = await merkleDistributorContract.claim(tokensToClaim);
    await claimTx.wait();

    console.log(`claimed account: ${account}`);
  }
};

testAvalancheClaims().then().catch();
