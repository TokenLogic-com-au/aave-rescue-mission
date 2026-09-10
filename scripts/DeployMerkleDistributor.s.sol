// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import {Script, console} from 'forge-std/Script.sol';
import {AaveMerkleDistributor} from 'rescue-mission-phase-1/contracts/AaveMerkleDistributor.sol';
import {MiscEthereum} from 'aave-address-book/MiscEthereum.sol';
import {MiscPolygon} from 'aave-address-book/MiscPolygon.sol';
import {MiscOptimism} from 'aave-address-book/MiscOptimism.sol';
import {MiscAvalanche} from 'aave-address-book/MiscAvalanche.sol';
import {GovernanceV3Arbitrum} from 'aave-address-book/GovernanceV3Arbitrum.sol';
import {GovernanceV3BNB} from 'aave-address-book/GovernanceV3BNB.sol';
import {GovernanceV3Base} from 'aave-address-book/GovernanceV3Base.sol';
import {GovernanceV3Celo} from 'aave-address-book/GovernanceV3Celo.sol';
import {GovernanceV3Gnosis} from 'aave-address-book/GovernanceV3Gnosis.sol';
import {GovernanceV3Ink} from 'aave-address-book/GovernanceV3Ink.sol';
import {GovernanceV3Linea} from 'aave-address-book/GovernanceV3Linea.sol';
import {GovernanceV3Mantle} from 'aave-address-book/GovernanceV3Mantle.sol';
import {GovernanceV3MegaEth} from 'aave-address-book/GovernanceV3MegaEth.sol';
import {GovernanceV3Metis} from 'aave-address-book/GovernanceV3Metis.sol';
import {GovernanceV3Monad} from 'aave-address-book/GovernanceV3Monad.sol';
import {GovernanceV3Plasma} from 'aave-address-book/GovernanceV3Plasma.sol';
import {GovernanceV3Scroll} from 'aave-address-book/GovernanceV3Scroll.sol';
import {GovernanceV3Soneium} from 'aave-address-book/GovernanceV3Soneium.sol';
import {GovernanceV3Sonic} from 'aave-address-book/GovernanceV3Sonic.sol';
import {GovernanceV3XLayer} from 'aave-address-book/GovernanceV3XLayer.sol';
import {GovernanceV3ZkSync} from 'aave-address-book/GovernanceV3ZkSync.sol';

/**
 * @title DistributorTargets
 * @notice Resolves the AaveMerkleDistributor owner per chain id: the Governance V3 Level 1
 *         executor. Reverts for chains that already have a distributor and for chains without a
 *         Governance V3 executor.
 */
library DistributorTargets {
  error DistributorAlreadyDeployed(uint256 chainId, address distributor);
  error UnsupportedChain(uint256 chainId);

  function executorFor(uint256 chainId) internal pure returns (address) {
    // Distributors already deployed in Phase 1 and Phase 2&3, listed in the address book.
    if (chainId == 1)
      revert DistributorAlreadyDeployed(chainId, MiscEthereum.AAVE_MERKLE_DISTRIBUTOR);
    if (chainId == 137)
      revert DistributorAlreadyDeployed(chainId, MiscPolygon.AAVE_MERKLE_DISTRIBUTOR);
    if (chainId == 10)
      revert DistributorAlreadyDeployed(chainId, MiscOptimism.AAVE_MERKLE_DISTRIBUTOR);
    if (chainId == 43114)
      revert DistributorAlreadyDeployed(chainId, MiscAvalanche.AAVE_MERKLE_DISTRIBUTOR);

    // Production V3 markets without a distributor yet.
    if (chainId == 56) return GovernanceV3BNB.EXECUTOR_LVL_1;
    if (chainId == 100) return GovernanceV3Gnosis.EXECUTOR_LVL_1;
    if (chainId == 143) return GovernanceV3Monad.EXECUTOR_LVL_1;
    if (chainId == 146) return GovernanceV3Sonic.EXECUTOR_LVL_1;
    if (chainId == 196) return GovernanceV3XLayer.EXECUTOR_LVL_1;
    if (chainId == 324) return GovernanceV3ZkSync.EXECUTOR_LVL_1;
    if (chainId == 1088) return GovernanceV3Metis.EXECUTOR_LVL_1;
    if (chainId == 1868) return GovernanceV3Soneium.EXECUTOR_LVL_1;
    if (chainId == 4326) return GovernanceV3MegaEth.EXECUTOR_LVL_1;
    if (chainId == 5000) return GovernanceV3Mantle.EXECUTOR_LVL_1;
    if (chainId == 8453) return GovernanceV3Base.EXECUTOR_LVL_1;
    if (chainId == 9745) return GovernanceV3Plasma.EXECUTOR_LVL_1;
    if (chainId == 42161) return GovernanceV3Arbitrum.EXECUTOR_LVL_1;
    if (chainId == 42220) return GovernanceV3Celo.EXECUTOR_LVL_1;
    if (chainId == 57073) return GovernanceV3Ink.EXECUTOR_LVL_1;
    if (chainId == 59144) return GovernanceV3Linea.EXECUTOR_LVL_1;
    if (chainId == 534352) return GovernanceV3Scroll.EXECUTOR_LVL_1;

    revert UnsupportedChain(chainId);
  }
}

/**
 * @title DeployMerkleDistributor
 * @notice Deploys an AaveMerkleDistributor and transfers ownership to the executor resolved for
 *         block.chainid. Usage: make deploy-distributor chain=<foundry.toml alias>
 * @dev zkSync requires the zksync Foundry toolchain.
 */
contract DeployMerkleDistributor is Script {
  function run() external returns (AaveMerkleDistributor distributor) {
    address owner = DistributorTargets.executorFor(block.chainid);

    vm.startBroadcast();
    distributor = new AaveMerkleDistributor();
    distributor.transferOwnership(owner);
    vm.stopBroadcast();

    require(distributor.owner() == owner, 'OWNERSHIP_NOT_TRANSFERRED');
    console.log('chain id', block.chainid);
    console.log('merkle distributor', address(distributor));
    console.log('owner (EXECUTOR_LVL_1)', owner);
  }
}
