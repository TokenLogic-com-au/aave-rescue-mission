// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import 'forge-std/Test.sol';
import {AaveGovernanceV2} from 'aave-address-book/AaveGovernanceV2.sol';
import {OptRescueMissionPayload} from '../src/contracts/OptRescueMissionPayload.sol';
import {AaveMerkleDistributor} from 'rescue-mission-phase-1/contracts/AaveMerkleDistributor.sol';

contract OptDeploy is Test {
  // contracts
  AaveMerkleDistributor public aaveMerkleDistributor;

  // payload
  OptRescueMissionPayload public payload;

  function run() public {
    vm.startBroadcast();

    aaveMerkleDistributor = new AaveMerkleDistributor();
    IOwnable(address(aaveMerkleDistributor)).transferOwnership(
      AaveGovernanceV2.OPTIMISM_BRIDGE_EXECUTOR
    );

    payload = new OptRescueMissionPayload(aaveMerkleDistributor);

    console.log('merkle distributor address', address(aaveMerkleDistributor));
    console.log('payload address', address(payload));

    vm.stopBroadcast();
  }
}

interface IOwnable {
  function transferOwnership(address newOwner) external;
}
