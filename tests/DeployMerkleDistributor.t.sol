// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import {Test} from 'forge-std/Test.sol';
import {AaveMerkleDistributor} from 'rescue-mission-phase-1/contracts/AaveMerkleDistributor.sol';
import {MiscEthereum} from 'aave-address-book/MiscEthereum.sol';
import {GovernanceV3Base} from 'aave-address-book/GovernanceV3Base.sol';
import {GovernanceV3Arbitrum} from 'aave-address-book/GovernanceV3Arbitrum.sol';
import {DistributorTargets, DeployMerkleDistributor} from '../scripts/DeployMerkleDistributor.s.sol';

contract DistributorTargetsHarness {
  function executorFor(uint256 chainId) external pure returns (address) {
    return DistributorTargets.executorFor(chainId);
  }
}

contract DeployMerkleDistributorTest is Test {
  DistributorTargetsHarness internal targets;

  function setUp() public {
    targets = new DistributorTargetsHarness();
  }

  function test_resolvesExecutorForNewChains() public view {
    assertEq(targets.executorFor(8453), GovernanceV3Base.EXECUTOR_LVL_1);
    assertEq(targets.executorFor(42161), GovernanceV3Arbitrum.EXECUTOR_LVL_1);
  }

  function test_refusesChainsWithExistingDistributor() public {
    vm.expectRevert(
      abi.encodeWithSelector(
        DistributorTargets.DistributorAlreadyDeployed.selector,
        1,
        MiscEthereum.AAVE_MERKLE_DISTRIBUTOR
      )
    );
    targets.executorFor(1);
  }

  function test_refusesUnsupportedChain() public {
    vm.expectRevert(abi.encodeWithSelector(DistributorTargets.UnsupportedChain.selector, 250));
    targets.executorFor(250);
  }

  function test_runDeploysAndTransfersOwnership() public {
    vm.chainId(8453);
    AaveMerkleDistributor distributor = new DeployMerkleDistributor().run();
    assertEq(distributor.owner(), GovernanceV3Base.EXECUTOR_LVL_1);
    assertEq(distributor._nextDistributionId(), 0);
  }
}
