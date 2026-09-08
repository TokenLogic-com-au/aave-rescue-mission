import 'dotenv';
import fs from 'fs';
import {GovV2Abi} from './abis/GovV2.json';
import {BigNumber, ethers, providers} from 'ethers';
import AaveMerkleDistributor from '../../out/AaveMerkleDistributor.sol/AaveMerkleDistributor.json';
import V1LendingPool from '../../out/LendingPool.sol/LendingPool.json';
import V2LendingPool from '../../out/contracts/protocol/lendingpool/LendingPool.sol/LendingPool.json';
import V2AmmLendingPool from '../../out/lendingpool/LendingPool.sol/LendingPool.json';
import V2AToken from '../../out/protocol/tokenization/AToken.sol/AToken.json';
import EthRescueMissionPayload from '../../out/EthRescueMissionPayload.sol/EthRescueMissionPayload.json';
import V2PoolReserveLogic from '../../out/contracts/protocol/libraries/logic/ReserveLogic.sol/ReserveLogic.json';
import V2PoolGenericLogic from '../../out/contracts/protocol/libraries/logic/GenericLogic.sol/GenericLogic.json';
import V2PoolValidationLogic from '../../out/contracts/protocol/libraries/logic/ValidationLogic.sol/ValidationLogic.json';

const TENDERLY_FORK_URL = process.env.TENDERLY_FORK_URL_MAINNET;
if (!TENDERLY_FORK_URL) throw new Error('missing TENDERLY_FORK_URL');

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

const AAVE_WHALE = '0x25F2226B597E8F9514B3F68F00f494cF4f286491';
const AAVE_MERKLE_DISTRIBUTOR = '0xa88c6D90eAe942291325f9ae3c66f3563B93FE10';

const giveEth = async (addresses: string[]) => {
  await provider.send('tenderly_addBalance', [
    addresses,
    //amount in wei will be added for all wallets
    ethers.utils.hexValue(ethers.utils.parseUnits('1000', 'ether').toHexString()),
  ]);
};

const deploy = async () => {
  await giveEth([AAVE_WHALE]);

  //---------------------------------------------------------------------------------------------------------------------------------
  //      DEPLOY DEPENDENCY CONTRACTS: V1_LENDING_POOL, V2_LENDING_POOL, V2_AMM_LENDING_POOL, V2_ATOKEN_RAI, V2_ATOKEN_USDT
  //---------------------------------------------------------------------------------------------------------------------------------

  // deploy v1 pool
  const v1PoolFactory = new ethers.ContractFactory(
    V1LendingPool.abi,
    V1LendingPool.bytecode,
    provider.getSigner(AAVE_WHALE)
  );
  const v1PoolContract = await v1PoolFactory.deploy();
  console.log(`[AaveV1LendingPoolImpl]: ${v1PoolContract.address}`);

  // deploy v2 pool and the required libraries
  const v2ReserveLogicFactory = new ethers.ContractFactory(
    V2PoolReserveLogic.abi,
    V2PoolReserveLogic.bytecode,
    provider.getSigner(AAVE_WHALE)
  );
  const v2ReserveLogicContract = await v2ReserveLogicFactory.deploy();
  console.log('[v2ReserveLogicContract]:', v2ReserveLogicContract.address);

  const v2GenericLogicFactory = new ethers.ContractFactory(
    V2PoolGenericLogic.abi,
    V2PoolGenericLogic.bytecode,
    provider.getSigner(AAVE_WHALE)
  );
  const v2GenericLogicContract = await v2GenericLogicFactory.deploy();
  console.log('[v2GenericLogicContract]:', v2GenericLogicContract.address);

  const v2ValidationLogicFactory = new ethers.ContractFactory(
    V2PoolValidationLogic.abi,
    linkLibraries(
      {
        bytecode: V2PoolValidationLogic.bytecode.object,
        linkReferences: V2PoolValidationLogic.bytecode.linkReferences,
      },
      {GenericLogic: v2GenericLogicContract.address}
    ),
    provider.getSigner(AAVE_WHALE)
  );
  const v2ValidationLogicContract = await v2ValidationLogicFactory.deploy();
  console.log('[v2ValidationLogicContract]:', v2ValidationLogicContract.address);

  // we need to manually link the libraries :)
  const v2PoolFactory = new ethers.ContractFactory(
    V2LendingPool.abi,
    linkLibraries(
      {
        bytecode: V2LendingPool.bytecode.object,
        linkReferences: V2LendingPool.bytecode.linkReferences,
      },
      {
        ReserveLogic: v2ReserveLogicContract.address,
        ValidationLogic: v2ValidationLogicContract.address,
      }
    ),
    provider.getSigner(AAVE_WHALE)
  );
  const v2PoolContract = await v2PoolFactory.deploy();
  console.log(`[AaveV2LendingPoolImpl]: ${v2PoolContract.address}`);

  // deploy v2 Amm Pool
  const v2AmmPoolFactory = new ethers.ContractFactory(
    V2AmmLendingPool.abi,
    linkLibraries(
      {
        bytecode: V2AmmLendingPool.bytecode.object,
        linkReferences: V2AmmLendingPool.bytecode.linkReferences,
      },
      {
        ReserveLogic: v2ReserveLogicContract.address,
        ValidationLogic: v2ValidationLogicContract.address,
      }
    ),
    provider.getSigner(AAVE_WHALE)
  );
  const v2AmmPoolContract = await v2AmmPoolFactory.deploy();
  console.log(`[AaveV2AmmLendingPoolImpl]: ${v2AmmPoolContract.address}`);

  const V2_POOL = '0x7d2768dE32b0b80b7a3454c06BdAc94A69DDc7A9';
  const USDT_UNDERLYING = '0xdAC17F958D2ee523a2206206994597C13D831ec7';
  const RAI_UNDERLYING = '0x03ab458634910AaD20eF5f1C8ee96F1D6ac54919';
  const V2_COLLECTOR = '0x464C71f6c2F760DdA6093dCB91C24c39e5d6e18c';
  const V2_REWARDS_CONTROLLER = '0xd784927Ff2f95ba542BfC824c8a8a98F3495f6b5';

  // deploy aRai
  const v2ATokenRaiFactory = new ethers.ContractFactory(
    V2AToken.abi,
    V2AToken.bytecode,
    provider.getSigner(AAVE_WHALE)
  );
  const v2ATokenRaiContract = await v2ATokenRaiFactory.deploy(
    V2_POOL,
    RAI_UNDERLYING,
    V2_COLLECTOR,
    'Aave interest bearing RAI',
    'aRAI',
    V2_REWARDS_CONTROLLER
  );
  console.log(`[V2ATokenRai]: ${v2ATokenRaiContract.address}`);

  // deploy aUsdt
  const v2ATokenUsdtFactory = new ethers.ContractFactory(
    V2AToken.abi,
    V2AToken.bytecode,
    provider.getSigner(AAVE_WHALE)
  );
  const v2ATokenUsdtContract = await v2ATokenUsdtFactory.deploy(
    V2_POOL,
    USDT_UNDERLYING,
    V2_COLLECTOR,
    'Aave interest bearing USDT',
    'aUSDt',
    V2_REWARDS_CONTROLLER
  );
  console.log(`[V2ATokenUsdt]: ${v2ATokenUsdtContract.address}`);

  //---------------------------------------------------------------------------------------------------------------------------------
  //                                                  DEPLOY PAYLOAD
  //---------------------------------------------------------------------------------------------------------------------------------

  const payloadFactory = new ethers.ContractFactory(
    EthRescueMissionPayload.abi,
    EthRescueMissionPayload.bytecode,
    provider.getSigner(AAVE_WHALE)
  );

  const payloadContract = await payloadFactory.deploy(
    AAVE_MERKLE_DISTRIBUTOR,
    v1PoolContract.address,
    v2PoolContract.address,
    v2AmmPoolContract.address,
    v2ATokenRaiContract.address,
    v2ATokenUsdtContract.address
  );
  console.log(`[Payload]: ${payloadContract.address}`);

  //---------------------------------------------------------------------------------------------------------------------------------
  //                                                  DEPLOY PROPOSAL
  //---------------------------------------------------------------------------------------------------------------------------------

  const GOV_V2 = '0xEC568fffba86c094cf06b22134B23074DFE2252c';
  const SHORT_EXECUTOR = '0xEE56e2B3D491590B5b31738cC34d5232F378a8D5';

  const govContractAaveWhale = new ethers.Contract(
    GOV_V2,
    GovV2Abi,
    provider.getSigner(AAVE_WHALE)
  );
  const proposalTx = await govContractAaveWhale.create(
    SHORT_EXECUTOR,
    [payloadContract.address],
    [0],
    ['execute()'],
    ['0x'],
    [true],
    '0x22f22ad910127d3ca76dc642f94db34397f94ca969485a216b9d82387808cdfa'
  );
  await proposalTx.wait();
  console.log('proposal created');
  const creationTimestamp = Math.floor(Date.now() / 1000) + 60 * 60 * 24; // now + 1 day

  //---------------------------------------------------------------------------------------------------------------------------------
  //                                                PASS PROPOSAL AND EXECUTE
  //---------------------------------------------------------------------------------------------------------------------------------

  // forward time to create window
  let currentBlockNumber = await provider.getBlockNumber();
  let currentBlock = await provider.getBlock(currentBlockNumber);
  await provider.send('evm_increaseTime', [
    ethers.BigNumber.from(creationTimestamp).sub(currentBlock.timestamp).add(1).toNumber(),
  ]);

  const proposalCount = await govContractAaveWhale.getProposalsCount();
  const proposalId = proposalCount - 1;
  console.log('proposalId', proposalId);

  // get proposals
  let proposal = await govContractAaveWhale.getProposalById(proposalId);
  const votingDelay = await govContractAaveWhale.getVotingDelay();

  currentBlockNumber = await provider.getBlockNumber();
  currentBlock = await provider.getBlock(currentBlockNumber);
  await provider.send('evm_increaseBlocks', [BigNumber.from(votingDelay).add(1).toHexString()]);

  // vote on proposals
  const voteTx = await govContractAaveWhale.submitVote(proposalId, true);
  await voteTx.wait();

  // forward time to end of vote for proposal
  await provider.send('evm_increaseBlocks', [
    BigNumber.from(proposal.endBlock).sub(BigNumber.from(proposal.startBlock)).add(1).toHexString(),
  ]);

  // queue proposal
  const queueTx = await govContractAaveWhale.queue(proposalId);
  await queueTx.wait();

  // forward time for proposal execution
  currentBlockNumber = await provider.getBlockNumber();
  currentBlock = await provider.getBlock(currentBlockNumber);
  proposal = await govContractAaveWhale.getProposalById(proposalId);
  await provider.send('evm_increaseTime', [
    BigNumber.from(proposal.executionTime).sub(currentBlock.timestamp).add(1).toNumber(),
  ]);

  // execute proposal
  const executeTx = await govContractAaveWhale.execute(proposalId);
  await executeTx.wait();
  console.log('Proposal executed');

  return {
    provider,
  };
};

const testEthereumClaims = async () => {
  const {provider} = await deploy();
  const claims = getMerkleTreeJson('./js-scripts/maps/ethereum/usersMerkleTrees.json');

  for (const account of Object.keys(claims)) {
    const merkleDistributorContract = new ethers.Contract(
      AAVE_MERKLE_DISTRIBUTOR,
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

testEthereumClaims().then().catch();
