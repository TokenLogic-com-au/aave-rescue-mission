import fs from 'fs';
import path from 'path';
import {describe, expect, it} from 'vitest';
import {formatUnits, getAddress, isAddress, type Address, type Hex} from 'viem';
import MerkleTree from './merkle-tree';
import BalanceTree from './balance-tree';
import {parseBalanceMap} from '../parse-balance-map';
import {
  PHASE4_DISTRIBUTIONS,
  buildRescueMapsFromAttribution,
  readAttributionJson,
} from '../generate-merkle-root';

const MAPS_DIR = path.resolve(__dirname, '../maps');

describe('MerkleTree', () => {
  it('throws on empty elements', () => {
    expect(() => new MerkleTree([])).toThrow('empty tree');
  });

  it('handles a single-element tree', () => {
    const leaf: Hex = '0x1111111111111111111111111111111111111111111111111111111111111111';
    const tree = new MerkleTree([leaf]);
    expect(tree.getRoot()).toBe(leaf);
    expect(tree.getHexRoot()).toBe(leaf);
    expect(tree.getProof(leaf)).toEqual([]);
  });

  it('sorts and deduplicates elements', () => {
    const a: Hex = '0x2222222222222222222222222222222222222222222222222222222222222222';
    const b: Hex = '0x1111111111111111111111111111111111111111111111111111111111111111';
    const tree1 = new MerkleTree([a, b, a]);
    const tree2 = new MerkleTree([b, a]);
    expect(tree1.getRoot()).toBe(tree2.getRoot());
  });

  it('verifies proofs for balanced and unbalanced trees', () => {
    const leaves: Hex[] = [
      '0x0000000000000000000000000000000000000000000000000000000000000001',
      '0x0000000000000000000000000000000000000000000000000000000000000002',
      '0x0000000000000000000000000000000000000000000000000000000000000003',
      '0x0000000000000000000000000000000000000000000000000000000000000004',
      '0x0000000000000000000000000000000000000000000000000000000000000005',
    ];
    const tree = new MerkleTree(leaves);
    const root = tree.getRoot();

    for (const leaf of leaves) {
      const proof = tree.getProof(leaf);
      expect(MerkleTree.verify(proof, root, leaf)).toBe(true);
    }

    const nonLeaf: Hex = '0x0000000000000000000000000000000000000000000000000000000000000099';
    expect(() => tree.getProof(nonLeaf)).toThrow('Element does not exist');
  });
});

describe('BalanceTree', () => {
  const ALICE: Address = '0x1111111111111111111111111111111111111111';
  const BOB: Address = '0x2222222222222222222222222222222222222222';

  it('computes leaf nodes correctly using abi.encodePacked', () => {
    const node = BalanceTree.toNode(0, ALICE, 1000n);
    expect(node).toMatch(/^0x[a-f0-9]{64}$/);
    expect(BalanceTree.toNode(0, ALICE, 1000n)).toBe(node);
    expect(BalanceTree.toNode(1, ALICE, 1000n)).not.toBe(node);
    expect(BalanceTree.toNode(0, BOB, 1000n)).not.toBe(node);
    expect(BalanceTree.toNode(0, ALICE, 1001n)).not.toBe(node);
  });

  it('generates verifiable proofs matching on-chain verification', () => {
    const balances = [
      {account: ALICE, amount: 1000n},
      {account: BOB, amount: 2000n},
    ];
    const tree = new BalanceTree(balances);
    const root = tree.getHexRoot();

    const aliceProof = tree.getProof(0, ALICE, 1000n);
    expect(BalanceTree.verifyProof(0, ALICE, 1000n, aliceProof, root)).toBe(true);
    expect(BalanceTree.verifyProof(0, ALICE, 999n, aliceProof, root)).toBe(false);
    expect(BalanceTree.verifyProof(1, ALICE, 1000n, aliceProof, root)).toBe(false);
    expect(BalanceTree.verifyProof(0, BOB, 1000n, aliceProof, root)).toBe(false);
  });
});

describe('parseBalanceMap', () => {
  it('throws on invalid address', () => {
    expect(() => parseBalanceMap({'not-an-address': {amount: '1000'}}, 18, 'token')).toThrow(
      'Found invalid address'
    );
  });

  it('throws on duplicate address with different casing', () => {
    const balances = [
      {address: '0x1111111111111111111111111111111111111111', earnings: '100', reasons: ''},
      {
        address: '0x1111111111111111111111111111111111111111'.toLowerCase(),
        earnings: '200',
        reasons: '',
      },
    ];
    expect(() => parseBalanceMap(balances, 18, 'token')).toThrow('Duplicate address');
  });

  it('throws on zero or negative amount', () => {
    expect(() =>
      parseBalanceMap({'0x1111111111111111111111111111111111111111': {amount: '0'}}, 18, 'token')
    ).toThrow('Invalid amount');
  });
});

describe('Phase 4 Merkle trees generated from attribution.json', () => {
  const attributionData = readAttributionJson();
  const rescueMaps = buildRescueMapsFromAttribution(attributionData);

  for (const config of PHASE4_DISTRIBUTIONS) {
    describe(`${config.networkName} ${config.name} (${config.key})`, () => {
      it('has candidate wallets in attribution matching group reconciliation', () => {
        const group = attributionData.groups.find(
          (g: any) =>
            g.chainAlias === config.chainAlias &&
            g.tokenSymbol === config.tokenSymbol &&
            g.holderSymbol === config.holderSymbol
        );
        expect(group).toBeDefined();

        const map = rescueMaps[config.key];
        expect(map).toBeDefined();

        let totalWei = 0n;
        for (const [account, entry] of Object.entries(map)) {
          expect(isAddress(account)).toBe(true);
          expect(getAddress(account)).toBe(account);
          expect(BigInt(entry.amount)).toBeGreaterThan(0n);
          expect(entry.txns.length).toBeGreaterThan(0);
          totalWei += BigInt(entry.amount);
        }

        expect(totalWei.toString()).toBe(group.reconciliation.candidates);
      });

      it('generates valid Merkle tree with verifiable proofs for every claimant', () => {
        const map = rescueMaps[config.key];
        const tree = parseBalanceMap(map, config.decimals, `${config.networkName}_${config.name}`);

        expect(tree.merkleRoot).toMatch(/^0x[a-f0-9]{64}$/);
        expect(Object.keys(tree.claims).length).toBe(Object.keys(map).length);

        const root = tree.merkleRoot as Hex;
        let sumWei = 0n;

        for (const [account, claim] of Object.entries(tree.claims)) {
          const valid = BalanceTree.verifyProof(
            claim.index,
            account as Address,
            BigInt(claim.amountInWei),
            claim.proof as Hex[],
            root
          );
          expect(valid).toBe(true);

          // Invariant checks
          expect(
            BalanceTree.verifyProof(
              claim.index + 1,
              account as Address,
              BigInt(claim.amountInWei),
              claim.proof as Hex[],
              root
            )
          ).toBe(false);
          expect(
            BalanceTree.verifyProof(
              claim.index,
              account as Address,
              BigInt(claim.amountInWei) + 1n,
              claim.proof as Hex[],
              root
            )
          ).toBe(false);

          sumWei += BigInt(claim.amountInWei);
        }

        expect(sumWei.toString()).toBe(tree.tokenTotalInWei);
        expect(tree.tokenTotal).toBe(
          `${formatUnits(sumWei, config.decimals)} ${config.networkName}_${config.name}`
        );
      });

      it('matches on-disk generated artifacts', () => {
        const treePath = path.resolve(
          MAPS_DIR,
          `${config.networkName}/merkleTree/${config.name}RescueMerkleTree.json`
        );
        const mapPath = path.resolve(
          MAPS_DIR,
          `${config.networkName}/${config.name}RescueMap.json`
        );
        const fmtPath = path.resolve(
          MAPS_DIR,
          `${config.networkName}/formatted/${config.name}RescueMapFormatted.json`
        );

        expect(fs.existsSync(treePath)).toBe(true);
        expect(fs.existsSync(mapPath)).toBe(true);
        expect(fs.existsSync(fmtPath)).toBe(true);

        const onDiskTree = JSON.parse(fs.readFileSync(treePath, 'utf8'));
        const onDiskMap = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
        const onDiskFmt = JSON.parse(fs.readFileSync(fmtPath, 'utf8'));

        expect(onDiskMap).toEqual(rescueMaps[config.key]);
        expect(Object.keys(onDiskTree.claims).length).toBe(
          Object.keys(rescueMaps[config.key]).length
        );

        for (const [account, formattedVal] of Object.entries(onDiskFmt)) {
          const entry = rescueMaps[config.key][account];
          expect(entry).toBeDefined();
          const expected = `${formatUnits(BigInt(entry.amount), config.decimals)} ${config.name}`;
          expect(formattedVal).toBe(expected);
        }
      });
    });
  }

  it('aggregates users correctly across all networks', () => {
    const commonAmountsPath = path.resolve(MAPS_DIR, 'usersAmounts.json');
    const commonTreesPath = path.resolve(MAPS_DIR, 'usersMerkleTrees.json');
    expect(fs.existsSync(commonAmountsPath)).toBe(true);
    expect(fs.existsSync(commonTreesPath)).toBe(true);

    const amounts = JSON.parse(fs.readFileSync(commonAmountsPath, 'utf8'));
    const trees = JSON.parse(fs.readFileSync(commonTreesPath, 'utf8'));

    expect(Object.keys(amounts).length).toBe(Object.keys(trees).length);
    expect(Object.keys(amounts).length).toBeGreaterThan(0);

    for (const [user, claimList] of Object.entries(trees) as [string, any[]][]) {
      expect(isAddress(user)).toBe(true);
      expect(Array.isArray(claimList)).toBe(true);
      expect(claimList.length).toBeGreaterThan(0);

      for (const item of claimList) {
        expect(item.distributionId).toBeDefined();
        expect(item.chainId).toBeDefined();
        expect(item.tokenAmount).toBeDefined();
        expect(item.tokenAmountInWei).toBeDefined();
        expect(Array.isArray(item.proof)).toBe(true);
      }
    }
  });

  it('resolves tokens by address and chain from the address book', async () => {
    const {tokenByAddressAndChain, getTokenDecimals} = await import('../common/helper');

    for (const config of PHASE4_DISTRIBUTIONS) {
      const token = tokenByAddressAndChain(config.tokenAddress, config.chainId);
      expect(token).toBeDefined();
      expect(token!.decimals).toBe(config.decimals);
      expect(getAddress(token!.address)).toBe(getAddress(config.tokenAddress));

      // Check getTokenDecimals
      const decimals = await getTokenDecimals(config.tokenAddress, config.chainId);
      expect(decimals).toBe(config.decimals);
    }

    // Case-insensitive address lookup
    const ethUsdt = tokenByAddressAndChain(
      '0xdAC17F958D2ee523a2206206994597C13D831ec7'.toLowerCase(),
      1
    );
    expect(ethUsdt).toBeDefined();
    expect(ethUsdt!.symbol).toBe('USDT');

    // Unknown token / chain returns undefined
    expect(tokenByAddressAndChain('0x0000000000000000000000000000000000000001', 1)).toBeUndefined();
    expect(
      tokenByAddressAndChain('0xdAC17F958D2ee523a2206206994597C13D831ec7', 999999)
    ).toBeUndefined();
  });
});
