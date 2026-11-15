/**
 * The SDK (sdk/src) and ReceiptRegistry implement docs/SCHEMA.md independently. These tests
 * prove they agree byte for byte: Merkle proofs, leaf, every EIP-712 digest and type hash,
 * the pinned fixture leaf, and signatures produced by the SDK's own signing helpers.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { getAddress, hashTypedData, keccak256, stringToHex, type Hex } from "viem";
import { network } from "hardhat";
import {
  batchAttestationTypedData,
  buildMerkleTree,
  EIP712_DOMAIN_NAME,
  EIP712_DOMAIN_VERSION,
  hashManifest,
  leafHash,
  receiptDigest,
  receiptFromManifest,
  serializeReceiptTypedData,
  serviceAttestationTypedData,
  signReceipt,
  verifyMerkleProof,
  type ManifestV1,
  type ReceiptFields,
} from "@hemi-receipts/sdk";
import { asStruct, deployRegistry, makeReceipt, randomBytes32, signBatchAttestation, signServiceAttestation } from "./helpers.js";

const FIXTURE_PATH = new URL("../../examples/manifests/fixture-v1.json", import.meta.url);
/** Pinned in docs/SCHEMA.md §1.4. */
const PINNED_MANIFEST_HASH = "0xadaa427dec949c140fb8905ead326fa55b40780c8bb8522093d6bbd065e65ff4";
const PINNED_LEAF = "0x3417a283ae9026f6bf4739abba8c586f48aecfe1242050b8b8590dfaaa535e44";

/** Type strings exactly as docs/SCHEMA.md §4 prints them. */
const TYPE_STRINGS = {
  RECEIPT_TYPEHASH:
    "Receipt(bytes32 runId,bytes32 manifestHash,address agent,address principal,uint16 schemaVersion)",
  BATCH_ATTESTATION_TYPEHASH: "BatchAttestation(bytes32 root,uint32 count,uint16 schemaVersion,uint64 deadline)",
  SERVICE_ATTESTATION_TYPEHASH: "ServiceAttestation(bytes32 receiptDigest,uint64 deadline)",
} as const;

const TREE_SIZES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 16, 17, 64];

describe("SDK ↔ ReceiptRegistry agreement", async () => {
  const { viem, networkHelpers } = await network.create();

  async function registryFixture() {
    return deployRegistry(viem);
  }

  async function deadlineIn(seconds = 600n): Promise<bigint> {
    return BigInt(await networkHelpers.time.latest()) + seconds;
  }

  it("every proof from buildMerkleTree verifies on chain, for tree sizes 1..9, 16, 17 and 64", async () => {
    const f = await networkHelpers.loadFixture(registryFixture);
    const anchored: Array<{ batchId: bigint; receipts: ReceiptFields[]; tree: ReturnType<typeof buildMerkleTree> }> = [];

    for (const size of TREE_SIZES) {
      const receipts = Array.from({ length: size }, (_, i) =>
        makeReceipt(f.agent.account.address, i % 3 === 0 ? f.principal.account.address : f.agent.account.address),
      );
      const tree = buildMerkleTree(receipts.map(leafHash));
      if (size === 1) assert.equal(tree.root, leafHash(receipts[0]!), "a one-leaf root is the leaf");

      const deadline = await deadlineIn();
      const signature = await signBatchAttestation(f, f.service, {
        root: tree.root,
        count: size,
        schemaVersion: 1,
        deadline,
      });
      await f.registry.write.attestBatch([tree.root, size, 1, deadline, signature], { account: f.relayer.account });
      const batchId = await f.registry.read.batchIdOfRoot([tree.root]);
      assert.equal(batchId, BigInt(anchored.length + 1));
      anchored.push({ batchId, receipts, tree });
    }

    let checked = 0;
    for (const { batchId, receipts, tree } of anchored) {
      for (const receipt of receipts) {
        const leaf = leafHash(receipt);
        const proof = tree.proof(leaf);
        assert.equal(verifyMerkleProof(leaf, proof, tree.root), true, "SDK self-check");
        assert.equal(
          await f.registry.read.verifyInclusion([batchId, leaf, proof]),
          true,
          `verifyInclusion, size ${receipts.length}`,
        );
        assert.equal(
          await f.registry.read.verifyReceipt([batchId, asStruct(receipt), proof]),
          true,
          `verifyReceipt, size ${receipts.length}`,
        );
        checked++;
      }
    }
    assert.equal(checked, TREE_SIZES.reduce((a, b) => a + b, 0));

    // And a proof does not carry over to a different leaf of the same tree.
    const { batchId, receipts, tree } = anchored.find((a) => a.receipts.length === 17)!;
    const proofOfFirst = tree.proof(leafHash(receipts[0]!));
    assert.equal(await f.registry.read.verifyReceipt([batchId, asStruct(receipts[1]!), proofOfFirst]), false);
  });

  it("the contract's leafHash, receiptDigest and both service digests equal the SDK's", async () => {
    const f = await networkHelpers.loadFixture(registryFixture);
    for (let i = 0; i < 8; i++) {
      const receipt = makeReceipt(f.agent.account.address, f.principal.account.address, 1 + (i % 3));
      const deadline = BigInt(1_800_000_000 + i * 7919);

      assert.equal(
        await f.registry.read.leafHash([receipt.runId, receipt.manifestHash, receipt.agent, receipt.principal]),
        leafHash(receipt),
      );

      const digest = await f.registry.read.receiptDigest([asStruct(receipt)]);
      assert.equal(digest, receiptDigest(receipt, f.domain));

      assert.equal(
        await f.registry.read.serviceAttestationDigest([digest, deadline]),
        hashTypedData(serviceAttestationTypedData(digest, deadline, f.domain)),
      );

      const batch = { root: randomBytes32(), count: 1 + i * 1000, schemaVersion: 1 + (i % 2), deadline };
      assert.equal(
        await f.registry.read.batchAttestationDigest([batch.root, batch.count, batch.schemaVersion, batch.deadline]),
        hashTypedData(batchAttestationTypedData(batch, f.domain)),
      );
    }
  });

  it("type hashes match docs/SCHEMA.md §4 and the domain matches the SDK's", async () => {
    const f = await networkHelpers.loadFixture(registryFixture);
    assert.equal(await f.registry.read.RECEIPT_TYPEHASH(), keccak256(stringToHex(TYPE_STRINGS.RECEIPT_TYPEHASH)));
    assert.equal(
      await f.registry.read.BATCH_ATTESTATION_TYPEHASH(),
      keccak256(stringToHex(TYPE_STRINGS.BATCH_ATTESTATION_TYPEHASH)),
    );
    assert.equal(
      await f.registry.read.SERVICE_ATTESTATION_TYPEHASH(),
      keccak256(stringToHex(TYPE_STRINGS.SERVICE_ATTESTATION_TYPEHASH)),
    );

    const [fields, name, version, chainId, verifyingContract, salt, extensions] = await f.registry.read.eip712Domain();
    assert.equal(fields, "0x0f", "name, version, chainId, verifyingContract; no salt");
    assert.equal(name, EIP712_DOMAIN_NAME);
    assert.equal(version, EIP712_DOMAIN_VERSION);
    assert.equal(Number(chainId), f.domain.chainId);
    assert.equal(verifyingContract, getAddress(f.domain.verifyingContract));
    assert.equal(salt, `0x${"0".repeat(64)}`);
    assert.deepEqual(extensions, []);
  });

  it("the SCHEMA.md fixture hashes to the pinned leaf, on chain and in the SDK, and anchors directly", async () => {
    const f = await networkHelpers.loadFixture(registryFixture);
    const manifest = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as ManifestV1;
    assert.equal(hashManifest(manifest), PINNED_MANIFEST_HASH);

    const receipt = receiptFromManifest(manifest);
    assert.equal(leafHash(receipt), PINNED_LEAF);
    assert.equal(
      await f.registry.read.leafHash([receipt.runId, receipt.manifestHash, receipt.agent, receipt.principal]),
      PINNED_LEAF,
    );

    // The fixture's agent is Hardhat's account #0 and its principal account #1, so the
    // fixture can be signed with the SDK and anchored for real.
    const [account0, account1] = await viem.getWalletClients();
    assert.equal(account0!.account.address.toLowerCase(), receipt.agent);
    assert.equal(account1!.account.address.toLowerCase(), receipt.principal);

    const agentSignature = await signReceipt(account0!, receipt, f.domain);
    const deadline = await deadlineIn();
    const serviceSignature = await signServiceAttestation(f, f.service, receipt, deadline);
    await f.registry.write.attest([asStruct(receipt), agentSignature, deadline, serviceSignature], {
      account: f.relayer.account,
    });
    assert.equal(await f.registry.read.batchIdOfRoot([PINNED_LEAF]), 1n);
    assert.equal((await f.registry.read.getBatch([1n])).root, PINNED_LEAF);
    assert.equal(await f.registry.read.verifyReceipt([1n, asStruct(receipt), []]), true);
  });

  it("an eth_signTypedData_v4 signature over serializeReceiptTypedData is accepted (browser-wallet path)", async () => {
    const f = await networkHelpers.loadFixture(registryFixture);
    const receipt = makeReceipt(f.agent.account.address, f.principal.account.address);
    const json = serializeReceiptTypedData(receipt, f.domain);
    const agentSignature = (await f.principal.request({
      method: "eth_signTypedData_v4",
      params: [f.principal.account.address, json],
    })) as Hex;

    const deadline = await deadlineIn();
    const serviceSignature = await signServiceAttestation(f, f.service, receipt, deadline);
    await f.registry.write.attest([asStruct(receipt), agentSignature, deadline, serviceSignature], {
      account: f.relayer.account,
    });
    assert.equal(await f.registry.read.batchIdOfRun([receipt.runId]), 1n);
  });

  it("SDK signReceipt works with a viem LocalAccount as well as a WalletClient", async () => {
    const f = await networkHelpers.loadFixture(registryFixture);
    const { privateKeyToAccount } = await import("viem/accounts");
    // Hardhat's well-known account #2 key (the `agent` wallet in the fixture).
    const local = privateKeyToAccount("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a");
    assert.equal(local.address, getAddress(f.agent.account.address));

    const receipt = makeReceipt(local.address);
    const agentSignature = await signReceipt(local, receipt, f.domain);
    const deadline = await deadlineIn();
    const serviceSignature = await signServiceAttestation(f, f.service, receipt, deadline);
    await f.registry.write.attest([asStruct(receipt), agentSignature, deadline, serviceSignature], {
      account: f.relayer.account,
    });
    assert.equal(await f.registry.read.batchIdOfRun([receipt.runId]), 1n);
  });
});
