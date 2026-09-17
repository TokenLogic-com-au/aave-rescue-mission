import MerkleTree from './merkle-tree';
import {encodePacked, getAddress, keccak256, type Address, type Hex} from 'viem';

export default class BalanceTree {
  private readonly tree: MerkleTree;

  constructor(balances: {account: Address; amount: bigint}[]) {
    this.tree = new MerkleTree(
      balances.map(({account, amount}, index) => {
        return BalanceTree.toNode(index, account, amount);
      })
    );
  }

  public static verifyProof(
    index: number | bigint,
    account: Address,
    amount: bigint,
    proof: Hex[],
    root: Hex
  ): boolean {
    let pair = BalanceTree.toNode(index, account, amount);
    for (const item of proof) {
      pair = MerkleTree.combinedHash(pair, item);
    }

    return pair.toLowerCase() === root.toLowerCase();
  }

  // keccak256(abi.encodePacked(index, account, amount))
  public static toNode(index: number | bigint, account: Address, amount: bigint): Hex {
    return keccak256(
      encodePacked(
        ['uint256', 'address', 'uint256'],
        [BigInt(index), getAddress(account), BigInt(amount)]
      )
    );
  }

  public getHexRoot(): Hex {
    return this.tree.getHexRoot();
  }

  // returns the hex bytes32 values of the proof
  public getProof(index: number | bigint, account: Address, amount: bigint): Hex[] {
    return this.tree.getHexProof(BalanceTree.toNode(index, account, amount));
  }
}
