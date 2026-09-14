import {BigNumber} from 'ethers';
import {describe, expect, it} from 'vitest';
import BalanceTree from './balance-tree';
import MerkleTree from './merkle-tree';

const leaf = (n: number): Buffer => Buffer.alloc(32, n);
const account = (n: number): string => '0x' + n.toString(16).padStart(40, '0');

describe('MerkleTree', () => {
  it('rejects an empty set of leaves', () => {
    expect(() => new MerkleTree([])).toThrow('empty tree');
  });

  it('roots a single leaf as itself and proves it with an empty proof', () => {
    const tree = new MerkleTree([leaf(1)]);
    expect(tree.getRoot().equals(leaf(1))).toBe(true);
    expect(tree.getProof(leaf(1))).toEqual([]);
  });

  it('is independent of the order leaves are supplied in', () => {
    const a = new MerkleTree([leaf(1), leaf(2), leaf(3)]);
    const b = new MerkleTree([leaf(3), leaf(1), leaf(2)]);
    expect(a.getHexRoot()).toBe(b.getHexRoot());
  });

  it('silently collapses identical leaves - safe here only because the index makes every leaf unique', () => {
    const deduped = new MerkleTree([leaf(1), leaf(1), leaf(2)]);
    const distinct = new MerkleTree([leaf(1), leaf(2)]);
    expect(deduped.getHexRoot()).toBe(distinct.getHexRoot());
  });

  it('refuses to prove a leaf it does not hold', () => {
    const tree = new MerkleTree([leaf(1), leaf(2)]);
    expect(() => tree.getProof(leaf(3))).toThrow('Element does not exist in Merkle tree');
  });

  it('promotes the odd leaf unchanged when a layer has an odd width', () => {
    // three leaves: [a,b] combine, c is carried up alone, so the root is hash(hash(a,b), c)
    const tree = new MerkleTree([leaf(1), leaf(2), leaf(3)]);
    const sorted = [leaf(1), leaf(2), leaf(3)].sort(Buffer.compare);
    const expected = MerkleTree.combinedHash(
      MerkleTree.combinedHash(sorted[0], sorted[1]),
      sorted[2]
    );
    expect(tree.getRoot().equals(expected)).toBe(true);
  });

  it('hashes a pair the same way whichever side each element is on', () => {
    const ab = MerkleTree.combinedHash(leaf(1), leaf(2));
    const ba = MerkleTree.combinedHash(leaf(2), leaf(1));
    expect(ab.equals(ba)).toBe(true);
  });
});

describe('BalanceTree', () => {
  const balances = [
    {account: account(1), amount: BigNumber.from(100)},
    {account: account(2), amount: BigNumber.from(200)},
    {account: account(3), amount: BigNumber.from(300)},
  ];

  it('verifies the proof it generates for every leaf', () => {
    const tree = new BalanceTree(balances);
    const root = Buffer.from(tree.getHexRoot().slice(2), 'hex');
    balances.forEach(({account: a, amount}, index) => {
      const proof = tree.getProof(index, a, amount).map((p) => Buffer.from(p.slice(2), 'hex'));
      expect(BalanceTree.verifyProof(index, a, amount, proof, root), a).toBe(true);
    });
  });

  it('rejects a proof replayed with a different amount', () => {
    const tree = new BalanceTree(balances);
    const root = Buffer.from(tree.getHexRoot().slice(2), 'hex');
    const proof = tree
      .getProof(0, balances[0].account, balances[0].amount)
      .map((p) => Buffer.from(p.slice(2), 'hex'));
    const inflated = balances[0].amount.add(1);
    expect(BalanceTree.verifyProof(0, balances[0].account, inflated, proof, root)).toBe(false);
  });

  it('rejects a proof replayed under a different index or account', () => {
    const tree = new BalanceTree(balances);
    const root = Buffer.from(tree.getHexRoot().slice(2), 'hex');
    const proof = tree
      .getProof(0, balances[0].account, balances[0].amount)
      .map((p) => Buffer.from(p.slice(2), 'hex'));
    expect(BalanceTree.verifyProof(1, balances[0].account, balances[0].amount, proof, root)).toBe(
      false
    );
    expect(BalanceTree.verifyProof(0, account(9), balances[0].amount, proof, root)).toBe(false);
  });

  it('binds a leaf to keccak256(abi.encode(index, account, amount))', () => {
    const node = BalanceTree.toNode(0, account(1), BigNumber.from(100));
    expect(node.length).toBe(32);
    expect(node.equals(BalanceTree.toNode(0, account(1), BigNumber.from(100)))).toBe(true);
    expect(node.equals(BalanceTree.toNode(1, account(1), BigNumber.from(100)))).toBe(false);
  });
});
