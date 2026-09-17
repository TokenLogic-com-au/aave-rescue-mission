import {concat, keccak256, type Hex} from 'viem';

export default class MerkleTree {
  private readonly elements: Hex[];
  private readonly elementIndex: Record<Hex, number>;
  private readonly layers: Hex[][];

  constructor(elements: Hex[]) {
    this.elements = [...elements];
    // Sort elements lexicographically (matching Buffer.compare for equal-length hex strings)
    this.elements.sort((a, b) => a.localeCompare(b));
    // Deduplicate elements
    this.elements = this.elements.filter((el, idx) => idx === 0 || el !== this.elements[idx - 1]);

    this.elementIndex = this.elements.reduce<Record<Hex, number>>((memo, el, index) => {
      memo[el] = index;
      return memo;
    }, {});

    // Create layers
    this.layers = this.getLayers(this.elements);
  }

  getLayers(elements: Hex[]): Hex[][] {
    if (elements.length === 0) {
      throw new Error('empty tree');
    }

    const layers: Hex[][] = [];
    layers.push(elements);

    // Get next layer until we reach the root
    while (layers[layers.length - 1].length > 1) {
      layers.push(this.getNextLayer(layers[layers.length - 1]));
    }

    return layers;
  }

  getNextLayer(elements: Hex[]): Hex[] {
    return elements.reduce<Hex[]>((layer, el, idx, arr) => {
      if (idx % 2 === 0) {
        // Hash the current element with its pair element
        layer.push(MerkleTree.combinedHash(el, arr[idx + 1]));
      }

      return layer;
    }, []);
  }

  static combinedHash(first?: Hex, second?: Hex): Hex {
    if (!first) {
      return second!;
    }
    if (!second) {
      return first;
    }

    return keccak256(MerkleTree.sortAndConcat(first, second));
  }

  static verify(proof: Hex[], root: Hex, leaf: Hex): boolean {
    let computedHash = leaf;
    for (const proofElement of proof) {
      computedHash = MerkleTree.combinedHash(computedHash, proofElement);
    }
    return computedHash === root;
  }

  getRoot(): Hex {
    return this.layers[this.layers.length - 1][0];
  }

  getHexRoot(): Hex {
    return this.getRoot();
  }

  getProof(el: Hex): Hex[] {
    let idx = this.elementIndex[el];

    if (typeof idx !== 'number') {
      throw new Error('Element does not exist in Merkle tree');
    }

    return this.layers.reduce<Hex[]>((proof, layer) => {
      const pairElement = MerkleTree.getPairElement(idx, layer);

      if (pairElement) {
        proof.push(pairElement);
      }

      idx = Math.floor(idx / 2);

      return proof;
    }, []);
  }

  getHexProof(el: Hex): Hex[] {
    return this.getProof(el);
  }

  private static getPairElement(idx: number, layer: Hex[]): Hex | null {
    const pairIdx = idx % 2 === 0 ? idx + 1 : idx - 1;

    if (pairIdx < layer.length) {
      return layer[pairIdx];
    } else {
      return null;
    }
  }

  private static sortAndConcat(first: Hex, second: Hex): Hex {
    return first.localeCompare(second) <= 0 ? concat([first, second]) : concat([second, first]);
  }
}
