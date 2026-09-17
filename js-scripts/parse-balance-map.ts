import {formatUnits, getAddress, isAddress, type Address} from 'viem';
import BalanceTree from './merkle-trees/balance-tree';

// This is the blob that gets distributed and pinned to IPFS.
// It is completely sufficient for recreating the entire merkle tree.
// Anyone can verify that all airdrops are included in the tree,
// and the tree has no additional distributions.
export interface MerkleDistributorInfo {
  merkleRoot: string;
  tokenTotal: string;
  tokenTotalInWei: string;
  claims: {
    [account: string]: {
      index: number;
      amount: string;
      amountInWei: string;
      proof: string[];
      flags?: {
        [flag: string]: boolean;
      };
    };
  };
}

export type OldFormat = {
  [account: string]: {amount: string | bigint; label?: string; txns?: string[]};
};
export type NewFormat = {address: string; earnings: string | bigint; reasons?: string};

export function parseBalanceMap(
  balances: OldFormat | NewFormat[],
  decimals: number,
  name: string
): MerkleDistributorInfo {
  // if balances are in an old format, process them
  const balancesInNewFormat: NewFormat[] = Array.isArray(balances)
    ? balances
    : Object.keys(balances).map((account): NewFormat => ({
        address: account,
        earnings: balances[account].amount.toString(),
        reasons: '',
      }));

  const dataByAddress = balancesInNewFormat.reduce<{
    [address: string]: {
      amount: bigint;
      flags?: {[flag: string]: boolean};
    };
  }>((memo, {address: account, earnings, reasons = ''}) => {
    if (!isAddress(account)) {
      throw new Error(`Found invalid address: ${account}`);
    }
    const parsed = getAddress(account);
    if (memo[parsed]) throw new Error(`Duplicate address: ${parsed}`);
    const parsedNum = BigInt(earnings);
    if (parsedNum <= 0n) throw new Error(`Invalid amount for account: ${account}`);

    const flags = {
      isSOCKS: reasons.includes('socks'),
      isLP: reasons.includes('lp'),
      isUser: reasons.includes('user'),
    };

    memo[parsed] = {amount: parsedNum, ...(reasons === '' ? {} : {flags})};
    return memo;
  }, {});

  const sortedAddresses = Object.keys(dataByAddress).sort();

  // construct a tree
  const tree = new BalanceTree(
    sortedAddresses.map((address) => ({
      account: address as Address,
      amount: dataByAddress[address].amount,
    }))
  );

  // generate claims
  const claims = sortedAddresses.reduce<{
    [address: string]: {
      amount: string;
      amountInWei: string;
      index: number;
      proof: string[];
      flags?: {[flag: string]: boolean};
    };
  }>((memo, address, index) => {
    const {amount, flags} = dataByAddress[address];
    memo[address] = {
      index,
      amountInWei: amount.toString(),
      amount: `${formatUnits(amount, decimals)} ${name}`,
      proof: tree.getProof(index, address as Address, amount),
      ...(flags ? {flags} : {}),
    };
    return memo;
  }, {});

  const tokenTotal = sortedAddresses.reduce<bigint>(
    (memo, key) => memo + dataByAddress[key].amount,
    0n
  );

  return {
    merkleRoot: tree.getHexRoot(),
    tokenTotal: `${formatUnits(tokenTotal, decimals)} ${name}`,
    tokenTotalInWei: tokenTotal.toString(),
    claims,
  };
}
