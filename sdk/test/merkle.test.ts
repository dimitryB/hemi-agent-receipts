import { test } from "node:test";
import assert from "node:assert/strict";
import { concat, keccak256, toHex, type Hex } from "viem";
import { buildMerkleTree, hashPair, processProof, verifyMerkleProof } from "../src/index.js";

const leafOf = (i: number): Hex => keccak256(toHex(`leaf-${i}`));
const leaves = (n: number, offset = 0): Hex[] => Array.from({ length: n }, (_, i) => leafOf(i + offset));

function shuffle<T>(items: T[], seed: number): T[] {
  const out = [...items];
  let s = seed;
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) % 2 ** 31;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** Independent reference: recursive sorted-pair tree over sorted leaves, odd node carried up. */
function referenceRoot(input: Hex[]): Hex {
  let level = [...input].map((l) => l.toLowerCase() as Hex).sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
  while (level.length > 1) {
    const next: Hex[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const a = level[i]!;
      const b = level[i + 1];
      next.push(b === undefined ? a : BigInt(a) < BigInt(b) ? keccak256(concat([a, b])) : keccak256(concat([b, a])));
    }
    level = next;
  }
  return level[0]!;
}

test("hashPair is commutative keccak256(min ‖ max)", () => {
  const [a, b] = leaves(2);
  assert.equal(hashPair(a!, b!), hashPair(b!, a!));
  const [lo, hi] = BigInt(a!) < BigInt(b!) ? [a!, b!] : [b!, a!];
  assert.equal(hashPair(a!, b!), keccak256(concat([lo, hi])));
});

test("sizes 1..65: every proof verifies and the root matches an independent reference", () => {
  for (let n = 1; n <= 65; n++) {
    const input = leaves(n);
    const tree = buildMerkleTree(input);
    assert.equal(tree.root, referenceRoot(input), `root for n=${n}`);
    assert.equal(tree.leaves.length, n);
    const depth = Math.ceil(Math.log2(n));
    for (const leaf of input) {
      const proof = tree.proof(leaf);
      assert.ok(proof.length <= depth, `proof length ${proof.length} > depth ${depth} for n=${n}`);
      assert.ok(verifyMerkleProof(leaf, proof, tree.root), `n=${n} leaf ${leaf}`);
      assert.equal(processProof(leaf, proof), tree.root);
    }
  }
});

test("a one-leaf tree's root is the leaf and its proof is empty", () => {
  const [leaf] = leaves(1);
  const tree = buildMerkleTree([leaf!]);
  assert.equal(tree.root, leaf);
  assert.deepEqual(tree.proof(leaf!), []);
});

test("the root does not depend on submission order", () => {
  for (const n of [2, 3, 7, 16, 33]) {
    const input = leaves(n);
    const root = buildMerkleTree(input).root;
    for (const seed of [1, 2, 3]) assert.equal(buildMerkleTree(shuffle(input, seed)).root, root, `n=${n} seed=${seed}`);
    assert.equal(buildMerkleTree([...input].reverse()).root, root);
  }
});

test("leaves are accepted in any hex case and committed lowercase", () => {
  const input = leaves(5);
  const upper = input.map((l) => `0x${l.slice(2).toUpperCase()}` as Hex);
  const tree = buildMerkleTree(upper);
  assert.equal(tree.root, buildMerkleTree(input).root);
  assert.ok(verifyMerkleProof(upper[2]!, tree.proof(upper[2]!), tree.root.toUpperCase().replace("0X", "0x") as Hex));
});

test("tampering fails: wrong leaf, flipped proof element, truncated, extended, or another leaf's proof", () => {
  const input = leaves(20);
  const tree = buildMerkleTree(input);
  const leaf = input[7]!;
  const proof = tree.proof(leaf);
  assert.ok(proof.length > 1);
  assert.equal(verifyMerkleProof(leafOf(999), proof, tree.root), false, "foreign leaf");
  for (let i = 0; i < proof.length; i++) {
    const bad = [...proof];
    const last = bad[i]!.slice(-1);
    bad[i] = (bad[i]!.slice(0, -1) + (last === "0" ? "1" : "0")) as Hex;
    assert.equal(verifyMerkleProof(leaf, bad, tree.root), false, `flipped element ${i}`);
  }
  assert.equal(verifyMerkleProof(leaf, proof.slice(0, -1), tree.root), false, "truncated");
  assert.equal(verifyMerkleProof(leaf, [...proof, leafOf(1)], tree.root), false, "extended");
  assert.equal(verifyMerkleProof(leaf, tree.proof(input[8]!), tree.root), false, "another leaf's proof");
  assert.equal(verifyMerkleProof(leaf, proof, buildMerkleTree(leaves(20, 100)).root), false, "another tree's root");
});

test("duplicates, empty input, non-bytes32 leaves and unknown leaves are rejected", () => {
  const input = leaves(4);
  assert.throws(() => buildMerkleTree([...input, input[2]!]), /duplicate leaf/);
  assert.throws(() => buildMerkleTree([input[0]!, `0x${input[0]!.slice(2).toUpperCase()}` as Hex]), /duplicate leaf/);
  assert.throws(() => buildMerkleTree([]), /at least one leaf/);
  assert.throws(() => buildMerkleTree(["0x1234"]), /not bytes32/);
  assert.throws(() => buildMerkleTree(input).proof(leafOf(77)), /not a leaf of this tree/);
});
