import fs from 'fs';
import path from 'path';
import {BigNumber, utils} from 'ethers';
import {describe, expect, it} from 'vitest';
import BalanceTree from './merkle-trees/balance-tree';
import {parseBalanceMap} from './parse-balance-map';

const MAPS = path.resolve(__dirname, 'maps');

/**
 * Input map, the tree generate-merkle-root.ts writes from it, and the token's
 * decimals. The decimals are asserted rather than derived: generate-merkle-root.ts
 * reads them over RPC, so a wrong response would produce a file that is internally
 * consistent at the wrong scale. Deriving the value from that file would agree with it.
 */
const DISTRIBUTIONS: {network: string; input: string; name: string; decimals: number}[] = [
  {network: 'ethereum', input: 'v2_aRaiRescueMap.json', name: 'v2_arai', decimals: 18},
  {network: 'ethereum', input: 'v1_aWbtcRescueMap.json', name: 'v1_awbtc', decimals: 8},
  {network: 'ethereum', input: 'usdtRescueMap.json', name: 'usdt', decimals: 6},
  {network: 'ethereum', input: 'daiRescueMap.json', name: 'dai', decimals: 18},
  {network: 'ethereum', input: 'gusdRescueMap.json', name: 'gusd', decimals: 2},
  {network: 'ethereum', input: 'linkRescueMap.json', name: 'link', decimals: 18},
  {network: 'ethereum', input: 'usdcRescueMap.json', name: 'usdc', decimals: 6},
  {network: 'polygon', input: 'v2_ausdcRescueMap.json', name: 'v2_ausdc', decimals: 6},
  {network: 'polygon', input: 'wbtcRescueMap.json', name: 'wbtc', decimals: 8},
  {network: 'polygon', input: 'v2_adaiRescueMap.json', name: 'v2_adai', decimals: 18},
  {network: 'polygon', input: 'usdcRescueMap.json', name: 'usdc', decimals: 6},
  {network: 'avalanche', input: 'usdt.eRescueMap.json', name: 'usdt.e', decimals: 6},
  {network: 'avalanche', input: 'usdc.eRescueMap.json', name: 'usdc.e', decimals: 6},
  {network: 'optimism', input: 'usdcRescueMap.json', name: 'usdc', decimals: 6},
];

type Claim = {index: number; amount: string; amountInWei: string; proof: string[]};
type Distribution = {
  merkleRoot: string;
  tokenTotal: string;
  tokenTotalInWei: string;
  claims: {[account: string]: Claim};
};

const readJson = (...parts: string[]) =>
  JSON.parse(fs.readFileSync(path.join(MAPS, ...parts), 'utf8'));

const treePath = (network: string, name: string) =>
  path.join(MAPS, network, 'merkleTree', `${name}RescueMerkleTree.json`);

const account = (n: number): string => '0x' + n.toString(16).padStart(40, '0');
const toBuf = (hex: string): Buffer => Buffer.from(hex.slice(2), 'hex');

describe('parseBalanceMap', () => {
  const balances = {
    [account(1)]: {amount: '100', txns: []},
    [account(2)]: {amount: '200', txns: []},
    [account(3)]: {amount: '300', txns: []},
  };

  it('rejects an address that is not an address', () => {
    expect(() => parseBalanceMap({'0xnope': {amount: '1', txns: []}}, 18, 't')).toThrow(
      'Found invalid address'
    );
  });

  it('rejects the same address supplied twice under different casing', () => {
    const lower = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const checksummed = utils.getAddress(lower);
    expect(checksummed, 'the two spellings differ').not.toBe(lower);
    const mixed = {
      [lower]: {amount: '1', txns: [] as string[]},
      [checksummed]: {amount: '2', txns: [] as string[]},
    };
    expect(() => parseBalanceMap(mixed, 18, 't')).toThrow('Duplicate address');
  });

  it('rejects a zero entitlement', () => {
    expect(() => parseBalanceMap({[account(1)]: {amount: '0', txns: []}}, 18, 't')).toThrow(
      'Invalid amount'
    );
  });

  it('rejects a negative entitlement', () => {
    expect(() => parseBalanceMap({[account(1)]: {amount: '-1', txns: []}}, 18, 't')).toThrow(
      'Invalid amount'
    );
  });

  it('rejects an empty distribution rather than rooting nothing', () => {
    expect(() => parseBalanceMap({}, 18, 't')).toThrow('empty tree');
  });

  it('indexes claims densely from zero', () => {
    const out = parseBalanceMap(balances, 18, 't');
    const indices = Object.values(out.claims)
      .map((c) => c.index)
      .sort((a, b) => a - b);
    expect(indices).toEqual([0, 1, 2]);
  });

  it('conserves value: the claims sum to the declared total', () => {
    const out = parseBalanceMap(balances, 18, 't');
    const sum = Object.values(out.claims).reduce(
      (memo, c) => memo.add(BigNumber.from(c.amountInWei)),
      BigNumber.from(0)
    );
    expect(sum.toString()).toBe(out.tokenTotalInWei);
    expect(sum.toString()).toBe('600');
  });

  it('is deterministic regardless of the order accounts are supplied in', () => {
    const reversed = Object.fromEntries(Object.entries(balances).reverse());
    expect(parseBalanceMap(reversed, 18, 't').merkleRoot).toBe(
      parseBalanceMap(balances, 18, 't').merkleRoot
    );
  });

  it('scales the display amount by decimals while leaving the root and wei untouched', () => {
    const six = parseBalanceMap(balances, 6, 't');
    const eighteen = parseBalanceMap(balances, 18, 't');
    expect(six.merkleRoot).toBe(eighteen.merkleRoot);
    expect(six.tokenTotalInWei).toBe(eighteen.tokenTotalInWei);
    expect(six.tokenTotal).not.toBe(eighteen.tokenTotal);
  });
});

describe('committed rescue distributions', () => {
  it('covers every committed tree, so a new distribution cannot be added unnoticed', () => {
    const onDisk = fs
      .readdirSync(MAPS, {recursive: true} as never)
      .map(String)
      .filter((f) => f.includes('merkleTree') && f.endsWith('.json'))
      .map((f) => path.join(MAPS, f))
      .sort();
    const expected = DISTRIBUTIONS.map((d) => treePath(d.network, d.name)).sort();
    expect(onDisk).toEqual(expected);
  });

  it.each(DISTRIBUTIONS)(
    'reproduces $network/$name exactly from its committed input map',
    ({network, input, name, decimals}) => {
      const source = readJson(network, input);
      const committed: Distribution = readJson(
        network,
        'merkleTree',
        `${name}RescueMerkleTree.json`
      );
      expect(parseBalanceMap(source, decimals, `${network}_${name}`)).toEqual(committed);
    }
  );

  it.each(DISTRIBUTIONS)(
    'holds every $network/$name claim provable against its own root',
    ({network, name}) => {
      const d: Distribution = readJson(network, 'merkleTree', `${name}RescueMerkleTree.json`);
      const root = toBuf(d.merkleRoot);
      const seen = new Set<number>();
      let sum = BigNumber.from(0);

      for (const [addr, claim] of Object.entries(d.claims)) {
        const amount = BigNumber.from(claim.amountInWei);
        expect(amount.gt(0), `${addr} is entitled to a positive amount`).toBe(true);
        expect(seen.has(claim.index), `${addr} has a unique index`).toBe(false);
        seen.add(claim.index);
        sum = sum.add(amount);
        expect(
          BalanceTree.verifyProof(claim.index, addr, amount, claim.proof.map(toBuf), root),
          `${addr} proof verifies`
        ).toBe(true);
      }

      expect(sum.toString(), 'claims sum to the declared total').toBe(d.tokenTotalInWei);
      expect(
        [...seen].sort((a, b) => a - b),
        'indices are dense from zero'
      ).toEqual(Array.from({length: seen.size}, (_, i) => i));
    }
  );
});
