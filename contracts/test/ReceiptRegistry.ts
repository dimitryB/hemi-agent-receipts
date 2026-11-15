import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  concat,
  getAddress,
  hashStruct,
  keccak256,
  parseEventLogs,
  parseSignature,
  serializeCompactSignature,
  serializeSignature,
  signatureToCompactSignature,
  toHex,
  type Address,
  type Hex,
} from "viem";
import { network } from "hardhat";
import { buildMerkleTree, receiptDigest, receiptTypes, type ReceiptFields } from "@hemi-receipts/sdk";
import {
  asStruct,
  deployRegistry,
  leafHash,
  makeReceipt,
  MAX_BATCH_COUNT,
  MAX_DEADLINE_WINDOW,
  randomBytes32,
  signBatchAttestation,
  signReceiptWith,
  signServiceAttestation,
  ZERO_ADDRESS,
  ZERO_HASH,
  type Fixture,
  type Wallet,
} from "./helpers.js";

const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

/** The same signature with s' = n - s and the other parity: valid for raw ecrecover, rejected by OZ. */
function malleate(signature: Hex): Hex {
  const { r, s, yParity } = parseSignature(signature);
  return serializeSignature({ r, s: toHex(SECP256K1_N - BigInt(s), { size: 32 }), yParity: yParity === 0 ? 1 : 0 });
}

/** EIP-2098 64-byte form of a valid signature. OZ 5's tryRecover(bytes) accepts only 65 bytes. */
function compact(signature: Hex): Hex {
  return serializeCompactSignature(signatureToCompactSignature(parseSignature(signature)));
}

function flipByte(value: Hex, index = 5): Hex {
  const bytes = value.slice(2).match(/../g)!;
  bytes[index] = (parseInt(bytes[index]!, 16) ^ 0x01).toString(16).padStart(2, "0");
  return `0x${bytes.join("")}` as Hex;
}

describe("ReceiptRegistry", async () => {
  const { viem, networkHelpers } = await network.create();

  async function registryFixture() {
    return deployRegistry(viem);
  }
  const load = () => networkHelpers.loadFixture(registryFixture);

  async function deadlineIn(seconds = 600n): Promise<bigint> {
    return BigInt(await networkHelpers.time.latest()) + seconds;
  }

  async function batchCall(
    f: Fixture,
    batch: { root: Hex; count: number; schemaVersion?: number; deadline?: bigint },
    opts: { signer?: Wallet; sender?: Wallet; signature?: Hex } = {},
  ) {
    const schemaVersion = batch.schemaVersion ?? 1;
    const deadline = batch.deadline ?? (await deadlineIn());
    const signature =
      opts.signature ??
      (await signBatchAttestation(f, opts.signer ?? f.service, { root: batch.root, count: batch.count, schemaVersion, deadline }));
    return f.registry.write.attestBatch([batch.root, batch.count, schemaVersion, deadline, signature], {
      account: (opts.sender ?? f.relayer).account,
    });
  }

  async function directCall(
    f: Fixture,
    receipt: ReceiptFields,
    opts: {
      agentSigner?: Wallet;
      serviceSigner?: Wallet;
      sender?: Wallet;
      deadline?: bigint;
      agentSignature?: Hex;
      serviceSignature?: Hex;
    } = {},
  ) {
    const deadline = opts.deadline ?? (await deadlineIn());
    const agentSignature = opts.agentSignature ?? (await signReceiptWith(f, opts.agentSigner ?? f.agent, receipt));
    const serviceSignature =
      opts.serviceSignature ?? (await signServiceAttestation(f, opts.serviceSigner ?? f.service, receipt, deadline));
    return f.registry.write.attest([asStruct(receipt), agentSignature, deadline, serviceSignature], {
      account: (opts.sender ?? f.relayer).account,
    });
  }

  async function receiptOf(f: Fixture, hash: Hex) {
    return f.publicClient.waitForTransactionReceipt({ hash });
  }

  async function blockTimestamp(f: Fixture, blockNumber: bigint) {
    return (await f.publicClient.getBlock({ blockNumber })).timestamp;
  }

  /* ------------------------------------------------------------------------------ */

  describe("deployment", () => {
    it("records owner and service signer, enables schema v1 and exposes the constants", async () => {
      const f = await load();
      assert.equal(await f.registry.read.owner(), getAddress(f.owner.account.address));
      assert.equal(await f.registry.read.serviceSigner(), getAddress(f.service.account.address));
      assert.equal(await f.registry.read.pendingOwner(), ZERO_ADDRESS);
      assert.equal(await f.registry.read.paused(), false);
      assert.equal(await f.registry.read.schemaVersionEnabled([1]), true);
      assert.equal(await f.registry.read.schemaVersionEnabled([0]), false);
      assert.equal(await f.registry.read.schemaVersionEnabled([2]), false);
      assert.equal(await f.registry.read.batchCount(), 0n);
      assert.equal(await f.registry.read.MAX_DEADLINE_WINDOW(), MAX_DEADLINE_WINDOW);
      assert.equal(await f.registry.read.MAX_BATCH_COUNT(), MAX_BATCH_COUNT);

      const [, name, version, chainId, verifyingContract] = await f.registry.read.eip712Domain();
      assert.equal(name, "HemiAgentReceipts");
      assert.equal(version, "1");
      assert.equal(chainId, BigInt(f.chainId));
      assert.equal(verifyingContract, getAddress(f.registry.address));
    });

    it("emits ServiceSignerUpdated and SchemaVersionSet from the constructor", async () => {
      const f = await load();
      const signerEvents = await f.publicClient.getContractEvents({
        address: f.registry.address,
        abi: f.registry.abi,
        eventName: "ServiceSignerUpdated",
        fromBlock: 0n,
      });
      assert.equal(signerEvents.length, 1);
      assert.deepEqual(signerEvents[0]!.args, {
        previousSigner: ZERO_ADDRESS,
        newSigner: getAddress(f.service.account.address),
      });
      const schemaEvents = await f.publicClient.getContractEvents({
        address: f.registry.address,
        abi: f.registry.abi,
        eventName: "SchemaVersionSet",
        fromBlock: 0n,
      });
      assert.equal(schemaEvents.length, 1);
      assert.deepEqual(schemaEvents[0]!.args, { version: 1, enabled: true });
    });

    it("rejects a zero service signer, a signer equal to the owner, and a zero owner", async () => {
      const f = await load();
      await viem.assertions.revertWithCustomError(
        viem.deployContract("ReceiptRegistry", [f.owner.account.address, ZERO_ADDRESS]),
        f.registry,
        "InvalidServiceSigner",
      );
      await viem.assertions.revertWithCustomError(
        viem.deployContract("ReceiptRegistry", [f.owner.account.address, f.owner.account.address]),
        f.registry,
        "InvalidServiceSigner",
      );
      await viem.assertions.revertWithCustomErrorWithArgs(
        viem.deployContract("ReceiptRegistry", [ZERO_ADDRESS, f.service.account.address]),
        f.registry,
        "OwnableInvalidOwner",
        [ZERO_ADDRESS],
      );
    });
  });

  /* ------------------------------------------------------------------------------ */

  describe("batch path", () => {
    it("anchors a root from any sender and emits BatchAttested with every field", async () => {
      const f = await load();
      const receipts = Array.from({ length: 5 }, () => makeReceipt(f.agent.account.address));
      const tree = buildMerkleTree(receipts.map(leafHash));

      const hash = await batchCall(f, { root: tree.root, count: 5 });
      await viem.assertions.emitWithArgs(hash, f.registry, "BatchAttested", [
        1n,
        tree.root,
        getAddress(f.service.account.address),
        5,
        1,
      ]);
      const txReceipt = await receiptOf(f, hash);
      const logs = parseEventLogs({ abi: f.registry.abi, logs: txReceipt.logs });
      assert.deepEqual(
        logs.map((log) => log.eventName),
        ["BatchAttested"],
        "the batch path emits no per-receipt events",
      );

      const batch = await f.registry.read.getBatch([1n]);
      assert.deepEqual(batch, {
        root: tree.root,
        count: 5,
        schemaVersion: 1,
        voided: false,
        serviceSigner: getAddress(f.service.account.address),
        attestedAt: await blockTimestamp(f, txReceipt.blockNumber),
        blockNumber: txReceipt.blockNumber,
      });
      assert.equal(await f.registry.read.batchCount(), 1n);
      assert.equal(await f.registry.read.batchIdOfRoot([tree.root]), 1n);
      assert.equal(await f.registry.read.batchIdOfRun([receipts[0]!.runId]), 0n, "batched runs are not tracked");

      for (const receipt of receipts) {
        const proof = tree.proof(leafHash(receipt));
        assert.equal(await f.registry.read.verifyReceipt([1n, asStruct(receipt), proof]), true);
        assert.equal(await f.registry.read.verifyInclusion([1n, leafHash(receipt), proof]), true);
      }
    });

    it("returns the new batch id", async () => {
      const f = await load();
      const root = randomBytes32();
      const deadline = await deadlineIn();
      const signature = await signBatchAttestation(f, f.service, { root, count: 3, schemaVersion: 1, deadline });
      const { result } = await f.registry.simulate.attestBatch([root, 3, 1, deadline, signature], {
        account: f.relayer.account.address,
      });
      assert.equal(result, 1n);
    });

    it("issues batch ids 1, 2, 3 across both paths", async () => {
      const f = await load();
      const rootA = randomBytes32();
      const receipt = makeReceipt(f.agent.account.address);
      const rootC = randomBytes32();

      await batchCall(f, { root: rootA, count: 2 });
      const directHash = await directCall(f, receipt);
      await viem.assertions.emitWithArgs(directHash, f.registry, "BatchAttested", [
        2n,
        leafHash(receipt),
        getAddress(f.service.account.address),
        1,
        1,
      ]);
      await batchCall(f, { root: rootC, count: 7 });

      assert.equal(await f.registry.read.batchCount(), 3n);
      assert.equal(await f.registry.read.batchIdOfRoot([rootA]), 1n);
      assert.equal(await f.registry.read.batchIdOfRoot([leafHash(receipt)]), 2n);
      assert.equal(await f.registry.read.batchIdOfRoot([rootC]), 3n);
      assert.equal(await f.registry.read.batchIdOfRun([receipt.runId]), 2n);
      assert.equal(await f.registry.read.batchIdOfRoot([randomBytes32()]), 0n);
      assert.equal((await f.registry.read.getBatch([3n])).count, 7);
    });

    it("bounds count to 1..MAX_BATCH_COUNT and rejects a zero root", async () => {
      const f = await load();
      await viem.assertions.revertWithCustomError(batchCall(f, { root: randomBytes32(), count: 0 }), f.registry, "InvalidBatch");
      await viem.assertions.revertWithCustomError(
        batchCall(f, { root: randomBytes32(), count: MAX_BATCH_COUNT + 1 }),
        f.registry,
        "InvalidBatch",
      );
      await viem.assertions.revertWithCustomError(batchCall(f, { root: ZERO_HASH, count: 1 }), f.registry, "InvalidBatch");

      await batchCall(f, { root: randomBytes32(), count: MAX_BATCH_COUNT });
      await batchCall(f, { root: randomBytes32(), count: 1 });
      assert.equal(await f.registry.read.batchCount(), 2n);
    });

    it("anchors a root only once", async () => {
      const f = await load();
      const root = randomBytes32();
      await batchCall(f, { root, count: 4 });
      await viem.assertions.revertWithCustomErrorWithArgs(
        batchCall(f, { root, count: 4 }),
        f.registry,
        "RootAlreadyAttested",
        [root, 1n],
      );
      // A fresh signature with different metadata does not help either.
      await viem.assertions.revertWithCustomErrorWithArgs(
        batchCall(f, { root, count: 9, deadline: await deadlineIn(1_200n) }),
        f.registry,
        "RootAlreadyAttested",
        [root, 1n],
      );
    });

    it("rejects a service signature from any other key", async () => {
      const f = await load();
      await viem.assertions.revertWithCustomError(
        batchCall(f, { root: randomBytes32(), count: 1 }, { signer: f.impostor }),
        f.registry,
        "InvalidServiceSignature",
      );
      await viem.assertions.revertWithCustomError(
        batchCall(f, { root: randomBytes32(), count: 1 }, { signer: f.owner }),
        f.registry,
        "InvalidServiceSignature",
      );
    });

    it("rejects a service signature over a different root, count, schemaVersion or deadline", async () => {
      const f = await load();
      await f.registry.write.setSchemaVersionEnabled([2, true], { account: f.owner.account });
      const root = randomBytes32();
      const deadline = await deadlineIn();
      const signed = { root, count: 10, schemaVersion: 1, deadline };
      const signature = await signBatchAttestation(f, f.service, signed);

      const tampered: Array<readonly [Hex, number, number, bigint]> = [
        [randomBytes32(), 10, 1, deadline], // root
        [root, 11, 1, deadline], // count
        [root, 10, 2, deadline], // schemaVersion
        [root, 10, 1, deadline + 1n], // deadline
      ];
      for (const args of tampered) {
        await viem.assertions.revertWithCustomError(
          f.registry.write.attestBatch([...args, signature], { account: f.relayer.account }),
          f.registry,
          "InvalidServiceSignature",
        );
      }
      // The untouched envelope still goes through: nothing above consumed it.
      await f.registry.write.attestBatch([root, 10, 1, deadline, signature], { account: f.relayer.account });
    });

    it("does not accept a ServiceAttestation as a BatchAttestation (type separation)", async () => {
      const f = await load();
      const root = randomBytes32();
      const deadline = await deadlineIn();
      // The service signs the direct-path envelope with `root` in the receiptDigest slot.
      const wrongType = await f.service.signTypedData({
        account: f.service.account,
        domain: f.domain,
        types: { ServiceAttestation: [{ name: "receiptDigest", type: "bytes32" }, { name: "deadline", type: "uint64" }] },
        primaryType: "ServiceAttestation",
        message: { receiptDigest: root, deadline },
      });
      await viem.assertions.revertWithCustomError(
        f.registry.write.attestBatch([root, 1, 1, deadline, wrongType], { account: f.relayer.account }),
        f.registry,
        "InvalidServiceSignature",
      );
    });

    it("rejects malformed service signature bytes with InvalidServiceSignature, never an OZ error", async () => {
      const f = await load();
      const root = randomBytes32();
      const deadline = await deadlineIn();
      const good = await signBatchAttestation(f, f.service, { root, count: 1, schemaVersion: 1, deadline });
      const malformed: Hex[] = [
        "0x",
        "0x1234",
        compact(good),
        malleate(good),
        `0x${"00".repeat(65)}`,
        concat([good, "0x00"]),
        `${good.slice(0, 130)}1f` as Hex, // v = 31
      ];
      for (const signature of malformed) {
        await viem.assertions.revertWithCustomError(
          f.registry.write.attestBatch([root, 1, 1, deadline, signature], { account: f.relayer.account }),
          f.registry,
          "InvalidServiceSignature",
        );
      }
      await f.registry.write.attestBatch([root, 1, 1, deadline, good], { account: f.relayer.account });
    });
  });

  /* ------------------------------------------------------------------------------ */

  describe("direct path", () => {
    it("anchors an agent-signed receipt as a batch of one, emitting BatchAttested then ReceiptAttested", async () => {
      const f = await load();
      const receipt = makeReceipt(f.agent.account.address, f.principal.account.address);
      const leaf = leafHash(receipt);

      const hash = await directCall(f, receipt);
      await viem.assertions.emitWithArgs(hash, f.registry, "BatchAttested", [
        1n,
        leaf,
        getAddress(f.service.account.address),
        1,
        1,
      ]);
      await viem.assertions.emitWithArgs(hash, f.registry, "ReceiptAttested", [
        receipt.runId,
        getAddress(receipt.agent),
        getAddress(receipt.principal),
        receipt.manifestHash,
        1n,
        1,
      ]);
      const txReceipt = await receiptOf(f, hash);
      const logs = parseEventLogs({ abi: f.registry.abi, logs: txReceipt.logs });
      assert.deepEqual(
        logs.map((log) => log.eventName),
        ["BatchAttested", "ReceiptAttested"],
      );

      assert.deepEqual(await f.registry.read.getBatch([1n]), {
        root: leaf,
        count: 1,
        schemaVersion: 1,
        voided: false,
        serviceSigner: getAddress(f.service.account.address),
        attestedAt: await blockTimestamp(f, txReceipt.blockNumber),
        blockNumber: txReceipt.blockNumber,
      });
      assert.equal(await f.registry.read.batchIdOfRun([receipt.runId]), 1n);
      assert.equal(await f.registry.read.batchIdOfRoot([leaf]), 1n);
      assert.equal(await f.registry.read.verifyReceipt([1n, asStruct(receipt), []]), true);
      assert.equal(await f.registry.read.verifyInclusion([1n, leaf, []]), true);
    });

    it("returns the new batch id", async () => {
      const f = await load();
      await batchCall(f, { root: randomBytes32(), count: 2 });
      const receipt = makeReceipt(f.agent.account.address);
      const deadline = await deadlineIn();
      const { result } = await f.registry.simulate.attest(
        [
          asStruct(receipt),
          await signReceiptWith(f, f.agent, receipt),
          deadline,
          await signServiceAttestation(f, f.service, receipt, deadline),
        ],
        { account: f.relayer.account.address },
      );
      assert.equal(result, 2n);
    });

    it("accepts a receipt signed by the principal instead of the agent", async () => {
      const f = await load();
      const receipt = makeReceipt(f.agent.account.address, f.principal.account.address);
      await directCall(f, receipt, { agentSigner: f.principal });
      assert.equal(await f.registry.read.verifyReceipt([1n, asStruct(receipt), []]), true);
    });

    it("rejects a receipt signed by anyone other than the agent or principal", async () => {
      const f = await load();
      const receipt = makeReceipt(f.agent.account.address, f.principal.account.address);
      await viem.assertions.revertWithCustomError(
        directCall(f, receipt, { agentSigner: f.impostor }),
        f.registry,
        "InvalidAgentSignature",
      );
      // The service key is not a substitute for the agent's.
      await viem.assertions.revertWithCustomError(
        directCall(f, receipt, { agentSigner: f.service }),
        f.registry,
        "InvalidAgentSignature",
      );
      const self = makeReceipt(f.agent.account.address);
      await viem.assertions.revertWithCustomError(
        directCall(f, self, { agentSigner: f.principal }),
        f.registry,
        "InvalidAgentSignature",
      );
      // Nothing was recorded, so the run is still usable with the right signature.
      await directCall(f, receipt);
      assert.equal(await f.registry.read.batchIdOfRun([receipt.runId]), 1n);
    });

    it("rejects an agent signature over a different receipt or another registry's domain", async () => {
      const f = await load();
      const receipt = makeReceipt(f.agent.account.address);
      const other = { ...receipt, manifestHash: flipByte(receipt.manifestHash) };
      await viem.assertions.revertWithCustomError(
        directCall(f, receipt, { agentSignature: await signReceiptWith(f, f.agent, other) }),
        f.registry,
        "InvalidAgentSignature",
      );
      const foreignDomain = { ...f.domain, verifyingContract: getAddress(f.other.account.address) };
      const foreign = await f.agent.signTypedData({
        account: f.agent.account,
        domain: foreignDomain,
        types: receiptTypes,
        primaryType: "Receipt",
        message: receipt,
      });
      await viem.assertions.revertWithCustomError(
        directCall(f, receipt, { agentSignature: foreign }),
        f.registry,
        "InvalidAgentSignature",
      );
    });

    it("rejects malformed agent signature bytes with InvalidAgentSignature", async () => {
      const f = await load();
      const receipt = makeReceipt(f.agent.account.address);
      const good = await signReceiptWith(f, f.agent, receipt);
      for (const agentSignature of ["0x", "0xdeadbeef", compact(good), malleate(good), `0x${"00".repeat(65)}`] as Hex[]) {
        await viem.assertions.revertWithCustomError(
          directCall(f, receipt, { agentSignature }),
          f.registry,
          "InvalidAgentSignature",
        );
      }
    });

    it("rejects a service signature from another key, over another receipt, or another deadline", async () => {
      const f = await load();
      const receipt = makeReceipt(f.agent.account.address);
      const deadline = await deadlineIn();
      await viem.assertions.revertWithCustomError(
        directCall(f, receipt, { serviceSigner: f.impostor }),
        f.registry,
        "InvalidServiceSignature",
      );
      await viem.assertions.revertWithCustomError(
        directCall(f, receipt, { serviceSigner: f.owner }),
        f.registry,
        "InvalidServiceSignature",
      );
      const otherReceipt = makeReceipt(f.agent.account.address);
      await viem.assertions.revertWithCustomError(
        directCall(f, receipt, { deadline, serviceSignature: await signServiceAttestation(f, f.service, otherReceipt, deadline) }),
        f.registry,
        "InvalidServiceSignature",
      );
      await viem.assertions.revertWithCustomError(
        directCall(f, receipt, {
          deadline,
          serviceSignature: await signServiceAttestation(f, f.service, receipt, deadline - 1n),
        }),
        f.registry,
        "InvalidServiceSignature",
      );
    });

    it("never lets one signature satisfy both checks (domain separation)", async () => {
      const f = await load();
      // The agent IS the service key here, the case the envelope exists for.
      const receipt = makeReceipt(f.service.account.address);
      const agentSignature = await signReceiptWith(f, f.service, receipt);

      await viem.assertions.revertWithCustomError(
        directCall(f, receipt, { agentSignature, serviceSignature: agentSignature }),
        f.registry,
        "InvalidServiceSignature",
      );

      // Envelope over the struct hash instead of the full digest: also rejected.
      const deadline = await deadlineIn();
      const structHash = hashStruct({ data: receipt, primaryType: "Receipt", types: receiptTypes });
      const overStructHash = await f.service.signTypedData({
        account: f.service.account,
        domain: f.domain,
        types: { ServiceAttestation: [{ name: "receiptDigest", type: "bytes32" }, { name: "deadline", type: "uint64" }] },
        primaryType: "ServiceAttestation",
        message: { receiptDigest: structHash, deadline },
      });
      await viem.assertions.revertWithCustomError(
        directCall(f, receipt, { agentSignature, deadline, serviceSignature: overStructHash }),
        f.registry,
        "InvalidServiceSignature",
      );

      // A BatchAttestation whose root is the leaf is not a ServiceAttestation either.
      const asBatch = await signBatchAttestation(f, f.service, {
        root: leafHash(receipt),
        count: 1,
        schemaVersion: 1,
        deadline,
      });
      await viem.assertions.revertWithCustomError(
        directCall(f, receipt, { agentSignature, deadline, serviceSignature: asBatch }),
        f.registry,
        "InvalidServiceSignature",
      );

      // With the proper envelope the same receipt goes through.
      await directCall(f, receipt, { agentSignature, deadline });
      assert.equal(await f.registry.read.batchIdOfRun([receipt.runId]), 1n);
    });

    it("rejects malformed service signature bytes with InvalidServiceSignature", async () => {
      const f = await load();
      const receipt = makeReceipt(f.agent.account.address);
      const deadline = await deadlineIn();
      const good = await signServiceAttestation(f, f.service, receipt, deadline);
      for (const serviceSignature of ["0x", "0x01", compact(good), malleate(good)] as Hex[]) {
        await viem.assertions.revertWithCustomError(
          directCall(f, receipt, { deadline, serviceSignature }),
          f.registry,
          "InvalidServiceSignature",
        );
      }
    });

    it("rejects zero fields with InvalidReceipt", async () => {
      const f = await load();
      const base = makeReceipt(f.agent.account.address, f.principal.account.address);
      const bad: ReceiptFields[] = [
        { ...base, runId: ZERO_HASH },
        { ...base, manifestHash: ZERO_HASH },
        { ...base, agent: ZERO_ADDRESS },
        { ...base, principal: ZERO_ADDRESS },
      ];
      for (const receipt of bad) {
        await viem.assertions.revertWithCustomError(
          directCall(f, receipt, { agentSigner: f.principal }),
          f.registry,
          "InvalidReceipt",
        );
      }
    });

    it("attests a run id only once", async () => {
      const f = await load();
      const receipt = makeReceipt(f.agent.account.address);
      await directCall(f, receipt);
      // Same run, different manifest: a different leaf, still a duplicate run.
      const again = { ...receipt, manifestHash: randomBytes32() };
      await viem.assertions.revertWithCustomErrorWithArgs(
        directCall(f, again),
        f.registry,
        "DuplicateRun",
        [receipt.runId, 1n],
      );
      await viem.assertions.revertWithCustomErrorWithArgs(
        directCall(f, receipt),
        f.registry,
        "DuplicateRun",
        [receipt.runId, 1n],
      );
    });

    it("rejects a leaf already anchored as a one-leaf batch, and vice versa", async () => {
      const f = await load();
      const receipt = makeReceipt(f.agent.account.address);
      const leaf = leafHash(receipt);
      await batchCall(f, { root: leaf, count: 1 });
      await viem.assertions.revertWithCustomErrorWithArgs(
        directCall(f, receipt),
        f.registry,
        "RootAlreadyAttested",
        [leaf, 1n],
      );

      const direct = makeReceipt(f.agent.account.address);
      await directCall(f, direct);
      await viem.assertions.revertWithCustomErrorWithArgs(
        batchCall(f, { root: leafHash(direct), count: 1 }),
        f.registry,
        "RootAlreadyAttested",
        [leafHash(direct), 2n],
      );
    });
  });

  /* ------------------------------------------------------------------------------ */

  describe("EIP-1271 contract wallets", () => {
    async function walletFixture() {
      const f = await deployRegistry(viem);
      // `other` holds the wallet's key; the wallet itself is the agent or principal.
      const wallet = await viem.deployContract("ERC1271WalletMock", [f.other.account.address]);
      return { ...f, wallet };
    }

    it("accepts a receipt approved by a contract wallet acting as the agent", async () => {
      const f = await networkHelpers.loadFixture(walletFixture);
      const receipt = makeReceipt(f.wallet.address, f.principal.account.address);
      await directCall(f, receipt, { agentSigner: f.other });
      assert.equal(await f.registry.read.verifyReceipt([1n, asStruct(receipt), []]), true);
    });

    it("accepts a receipt approved by a contract wallet acting as the principal", async () => {
      const f = await networkHelpers.loadFixture(walletFixture);
      const receipt = makeReceipt(f.agent.account.address, f.wallet.address);
      await directCall(f, receipt, { agentSigner: f.other });
      assert.equal(await f.registry.read.batchIdOfRun([receipt.runId]), 1n);
    });

    it("rejects when the wallet says no, reverts, or the wrong key signed", async () => {
      const f = await networkHelpers.loadFixture(walletFixture);
      const receipt = makeReceipt(f.wallet.address, f.principal.account.address);

      await viem.assertions.revertWithCustomError(
        directCall(f, receipt, { agentSigner: f.impostor }),
        f.registry,
        "InvalidAgentSignature",
      );

      await f.wallet.write.setMode([1]); // Reject
      await viem.assertions.revertWithCustomError(
        directCall(f, receipt, { agentSigner: f.other }),
        f.registry,
        "InvalidAgentSignature",
      );

      await f.wallet.write.setMode([2]); // Revert
      await viem.assertions.revertWithCustomError(
        directCall(f, receipt, { agentSigner: f.other }),
        f.registry,
        "InvalidAgentSignature",
      );

      // A contract wallet is never checked by ECDSA: the key holder's signature counts
      // only through the wallet's own answer.
      await f.wallet.write.setMode([0]);
      await directCall(f, receipt, { agentSigner: f.other });
    });
  });

  /* ------------------------------------------------------------------------------ */

  describe("checks and their order", () => {
    it("enforces the deadline window on both paths", async () => {
      const f = await load();
      for (const path of ["batch", "direct"] as const) {
        const submit = (deadline: bigint) =>
          path === "batch"
            ? batchCall(f, { root: randomBytes32(), count: 1, deadline })
            : directCall(f, makeReceipt(f.agent.account.address), { deadline });

        let next = BigInt(await networkHelpers.time.latest()) + 10n;
        await networkHelpers.time.setNextBlockTimestamp(next);
        await viem.assertions.revertWithCustomErrorWithArgs(submit(next - 1n), f.registry, "ExpiredSignature", [
          next - 1n,
        ]);

        await networkHelpers.time.setNextBlockTimestamp(next);
        await viem.assertions.revertWithCustomErrorWithArgs(
          submit(next + MAX_DEADLINE_WINDOW + 1n),
          f.registry,
          "DeadlineTooDistant",
          [next + MAX_DEADLINE_WINDOW + 1n],
        );

        // Both ends of the window are inclusive.
        await networkHelpers.time.setNextBlockTimestamp(next);
        await submit(next);
        next += 10n;
        await networkHelpers.time.setNextBlockTimestamp(next);
        await submit(next + MAX_DEADLINE_WINDOW);
      }
      assert.equal(await f.registry.read.batchCount(), 4n);
    });

    it("refuses a disabled schema version and accepts a newly enabled one", async () => {
      const f = await load();
      const earlier = makeReceipt(f.agent.account.address);
      await directCall(f, earlier);

      await viem.assertions.emitWithArgs(
        f.registry.write.setSchemaVersionEnabled([1, false], { account: f.owner.account }),
        f.registry,
        "SchemaVersionSet",
        [1, false],
      );
      assert.equal(await f.registry.read.schemaVersionEnabled([1]), false);
      await viem.assertions.revertWithCustomErrorWithArgs(
        batchCall(f, { root: randomBytes32(), count: 1 }),
        f.registry,
        "SchemaVersionDisabled",
        [1],
      );
      await viem.assertions.revertWithCustomErrorWithArgs(
        directCall(f, makeReceipt(f.agent.account.address)),
        f.registry,
        "SchemaVersionDisabled",
        [1],
      );
      await viem.assertions.revertWithCustomErrorWithArgs(
        directCall(f, makeReceipt(f.agent.account.address, f.agent.account.address, 2)),
        f.registry,
        "SchemaVersionDisabled",
        [2],
      );
      // Disabling a version does not touch what is already anchored.
      assert.equal(await f.registry.read.verifyReceipt([1n, asStruct(earlier), []]), true);

      await viem.assertions.emitWithArgs(
        f.registry.write.setSchemaVersionEnabled([2, true], { account: f.owner.account }),
        f.registry,
        "SchemaVersionSet",
        [2, true],
      );
      const v2 = makeReceipt(f.agent.account.address, f.agent.account.address, 2);
      await directCall(f, v2);
      const root = randomBytes32();
      await batchCall(f, { root, count: 3, schemaVersion: 2 });
      assert.equal((await f.registry.read.getBatch([3n])).schemaVersion, 2);
      assert.equal(await f.registry.read.verifyReceipt([2n, asStruct(v2), []]), true);

      await f.registry.write.setSchemaVersionEnabled([1, true], { account: f.owner.account });
      await batchCall(f, { root: randomBytes32(), count: 1 });
    });

    it("checks sanity, then schema, then deadline, then replay, then signatures", async () => {
      const f = await load();
      const usedRoot = randomBytes32();
      await batchCall(f, { root: usedRoot, count: 1 });
      const usedReceipt = makeReceipt(f.agent.account.address);
      await directCall(f, usedReceipt);
      await f.registry.write.setSchemaVersionEnabled([1, false], { account: f.owner.account });
      const garbage = "0x00" as Hex;
      const expired = BigInt(await networkHelpers.time.latest()) - 1n;

      // sanity before schema
      await viem.assertions.revertWithCustomError(
        batchCall(f, { root: ZERO_HASH, count: 1, deadline: expired }, { signature: garbage }),
        f.registry,
        "InvalidBatch",
      );
      await viem.assertions.revertWithCustomError(
        directCall(f, { ...usedReceipt, agent: ZERO_ADDRESS }, { deadline: expired, agentSignature: garbage, serviceSignature: garbage }),
        f.registry,
        "InvalidReceipt",
      );
      // schema before deadline
      await viem.assertions.revertWithCustomError(
        batchCall(f, { root: usedRoot, count: 1, deadline: expired }, { signature: garbage }),
        f.registry,
        "SchemaVersionDisabled",
      );
      await viem.assertions.revertWithCustomError(
        directCall(f, usedReceipt, { deadline: expired, agentSignature: garbage, serviceSignature: garbage }),
        f.registry,
        "SchemaVersionDisabled",
      );

      await f.registry.write.setSchemaVersionEnabled([1, true], { account: f.owner.account });
      // deadline before replay
      await viem.assertions.revertWithCustomError(
        batchCall(f, { root: usedRoot, count: 1, deadline: expired }, { signature: garbage }),
        f.registry,
        "ExpiredSignature",
      );
      await viem.assertions.revertWithCustomError(
        directCall(f, usedReceipt, { deadline: expired, agentSignature: garbage, serviceSignature: garbage }),
        f.registry,
        "ExpiredSignature",
      );
      // replay before signatures
      await viem.assertions.revertWithCustomError(
        batchCall(f, { root: usedRoot, count: 1 }, { signature: garbage }),
        f.registry,
        "RootAlreadyAttested",
      );
      await viem.assertions.revertWithCustomError(
        directCall(f, usedReceipt, { agentSignature: garbage, serviceSignature: garbage }),
        f.registry,
        "DuplicateRun",
      );
      // agent signature before service signature
      await viem.assertions.revertWithCustomError(
        directCall(f, makeReceipt(f.agent.account.address), { agentSignature: garbage, serviceSignature: garbage }),
        f.registry,
        "InvalidAgentSignature",
      );
    });
  });

  /* ------------------------------------------------------------------------------ */

  describe("verification", () => {
    async function anchoredTreeFixture() {
      const f = await deployRegistry(viem);
      const receipts = Array.from({ length: 6 }, (_, i) =>
        makeReceipt(f.agent.account.address, i % 2 === 0 ? f.principal.account.address : f.agent.account.address),
      );
      const tree = buildMerkleTree(receipts.map(leafHash));
      const deadline = BigInt(await networkHelpers.time.latest()) + 600n;
      const sig = await signBatchAttestation(f, f.service, { root: tree.root, count: 6, schemaVersion: 1, deadline });
      await f.registry.write.attestBatch([tree.root, 6, 1, deadline, sig], { account: f.relayer.account });
      // A second, unrelated batch.
      const otherRoot = randomBytes32();
      const sig2 = await signBatchAttestation(f, f.service, { root: otherRoot, count: 1, schemaVersion: 1, deadline });
      await f.registry.write.attestBatch([otherRoot, 1, 1, deadline, sig2], { account: f.relayer.account });
      return { ...f, receipts, tree };
    }

    it("returns false for a tampered receipt, proof or batch id", async () => {
      const f = await networkHelpers.loadFixture(anchoredTreeFixture);
      const receipt = f.receipts[2]!;
      const proof = f.tree.proof(leafHash(receipt));
      assert.equal(await f.registry.read.verifyReceipt([1n, asStruct(receipt), proof]), true);

      const tampered: Array<[string, ReceiptFields]> = [
        ["one byte of manifestHash", { ...receipt, manifestHash: flipByte(receipt.manifestHash) }],
        ["one byte of runId", { ...receipt, runId: flipByte(receipt.runId, 31) }],
        ["agent and principal swapped", { ...receipt, agent: receipt.principal, principal: receipt.agent }],
        ["another agent", { ...receipt, agent: f.impostor.account.address.toLowerCase() as Address }],
      ];
      for (const [what, bad] of tampered) {
        assert.equal(await f.registry.read.verifyReceipt([1n, asStruct(bad), proof]), false, what);
        assert.equal(await f.registry.read.verifyInclusion([1n, leafHash(bad), proof]), false, what);
      }

      for (const batchId of [0n, 2n, 3n, 2n ** 255n]) {
        assert.equal(await f.registry.read.verifyReceipt([batchId, asStruct(receipt), proof]), false, `batch ${batchId}`);
        assert.equal(await f.registry.read.verifyInclusion([batchId, leafHash(receipt), proof]), false);
      }

      const badProof = [...proof];
      badProof[0] = flipByte(badProof[0]!);
      assert.equal(await f.registry.read.verifyReceipt([1n, asStruct(receipt), badProof]), false, "tampered proof");
      assert.equal(await f.registry.read.verifyReceipt([1n, asStruct(receipt), proof.slice(1)]), false, "short proof");
      assert.equal(await f.registry.read.verifyReceipt([1n, asStruct(receipt), []]), false, "empty proof");
    });

    it("returns false when the receipt's schemaVersion differs from the batch's", async () => {
      const f = await networkHelpers.loadFixture(anchoredTreeFixture);
      const receipt = f.receipts[0]!;
      const proof = f.tree.proof(leafHash(receipt));
      // schemaVersion is not part of the leaf, so inclusion alone would still hold.
      assert.equal(await f.registry.read.verifyInclusion([1n, leafHash(receipt), proof]), true);
      assert.equal(await f.registry.read.verifyReceipt([1n, asStruct({ ...receipt, schemaVersion: 2 }), proof]), false);
      assert.equal(await f.registry.read.verifyReceipt([1n, asStruct({ ...receipt, schemaVersion: 0 }), proof]), false);
    });

    it("verifyInclusion accepts any tree node, verifyReceipt only a real receipt leaf", async () => {
      const f = await networkHelpers.loadFixture(anchoredTreeFixture);
      // An internal node with the rest of the path verifies as a bare node. That is why
      // receipts are proven with verifyReceipt, whose leaf has a 128-byte preimage.
      const internal = f.tree.layers[1]![0]!;
      const leaf = f.tree.leaves[0]!;
      const pathAbove = f.tree.proof(leaf).slice(1);
      assert.equal(await f.registry.read.verifyInclusion([1n, internal, pathAbove]), true);
      assert.equal(await f.registry.read.verifyInclusion([1n, f.tree.root, []]), true);
    });

    it("getBatch reverts UnknownBatch for an id that was never issued", async () => {
      const f = await networkHelpers.loadFixture(anchoredTreeFixture);
      await viem.assertions.revertWithCustomErrorWithArgs(f.registry.read.getBatch([0n]), f.registry, "UnknownBatch", [0n]);
      await viem.assertions.revertWithCustomErrorWithArgs(f.registry.read.getBatch([3n]), f.registry, "UnknownBatch", [3n]);
    });

    it("computes the leaf and digests the SDK computes", async () => {
      const f = await networkHelpers.loadFixture(anchoredTreeFixture);
      const receipt = f.receipts[1]!;
      assert.equal(
        await f.registry.read.leafHash([receipt.runId, receipt.manifestHash, receipt.agent, receipt.principal]),
        leafHash(receipt),
      );
      assert.equal(await f.registry.read.receiptDigest([asStruct(receipt)]), receiptDigest(receipt, f.domain));
      // Leaf preimage is abi.encode of four 32-byte words.
      assert.equal(
        leafHash(receipt),
        keccak256(
          concat([
            receipt.runId,
            receipt.manifestHash,
            toHex(BigInt(receipt.agent), { size: 32 }),
            toHex(BigInt(receipt.principal), { size: 32 }),
          ]),
        ),
      );
    });
  });

  /* ------------------------------------------------------------------------------ */

  describe("pause", () => {
    it("blocks both writes while every read keeps working", async () => {
      const f = await load();
      const receipt = makeReceipt(f.agent.account.address);
      await directCall(f, receipt);
      const root = randomBytes32();
      await batchCall(f, { root, count: 2 });

      await viem.assertions.emitWithArgs(
        f.registry.write.pause({ account: f.owner.account }),
        f.registry,
        "Paused",
        [getAddress(f.owner.account.address)],
      );
      assert.equal(await f.registry.read.paused(), true);

      await viem.assertions.revertWithCustomError(
        batchCall(f, { root: randomBytes32(), count: 1 }),
        f.registry,
        "EnforcedPause",
      );
      await viem.assertions.revertWithCustomError(
        directCall(f, makeReceipt(f.agent.account.address)),
        f.registry,
        "EnforcedPause",
      );

      assert.equal(await f.registry.read.verifyReceipt([1n, asStruct(receipt), []]), true);
      assert.equal(await f.registry.read.verifyInclusion([1n, leafHash(receipt), []]), true);
      assert.equal((await f.registry.read.getBatch([2n])).root, root);
      assert.equal(await f.registry.read.batchCount(), 2n);
      assert.equal(await f.registry.read.batchIdOfRoot([root]), 2n);
      assert.equal(await f.registry.read.batchIdOfRun([receipt.runId]), 1n);
      assert.equal(await f.registry.read.receiptDigest([asStruct(receipt)]), receiptDigest(receipt, f.domain));
      await f.registry.read.batchAttestationDigest([root, 2, 1, 1n]);
      await f.registry.read.serviceAttestationDigest([root, 1n]);
      assert.equal(await f.registry.read.schemaVersionEnabled([1]), true);
      assert.equal(await f.registry.read.serviceSigner(), getAddress(f.service.account.address));

      // Incident response works while paused.
      await f.registry.write.voidBatch([2n, root, "incident"], { account: f.owner.account });
      await viem.assertions.revertWithCustomError(
        f.registry.write.pause({ account: f.owner.account }),
        f.registry,
        "EnforcedPause",
      );

      await viem.assertions.emitWithArgs(
        f.registry.write.unpause({ account: f.owner.account }),
        f.registry,
        "Unpaused",
        [getAddress(f.owner.account.address)],
      );
      await viem.assertions.revertWithCustomError(
        f.registry.write.unpause({ account: f.owner.account }),
        f.registry,
        "ExpectedPause",
      );
      await batchCall(f, { root: randomBytes32(), count: 1 });
      await directCall(f, makeReceipt(f.agent.account.address));
      assert.equal(await f.registry.read.batchCount(), 4n);
    });
  });

  /* ------------------------------------------------------------------------------ */

  describe("voidBatch", () => {
    it("voids a named batch, keeps its root and run spent, and refuses a second void", async () => {
      const f = await load();
      const receipts = Array.from({ length: 3 }, () => makeReceipt(f.agent.account.address));
      const tree = buildMerkleTree(receipts.map(leafHash));
      await batchCall(f, { root: tree.root, count: 3 });
      const direct = makeReceipt(f.agent.account.address);
      await directCall(f, direct);
      const keep = randomBytes32();
      await batchCall(f, { root: keep, count: 1 });

      await viem.assertions.revertWithCustomErrorWithArgs(
        f.registry.write.voidBatch([1n, keep, "wrong target"], { account: f.owner.account }),
        f.registry,
        "VoidTargetMismatch",
        [tree.root, keep],
      );
      await viem.assertions.revertWithCustomErrorWithArgs(
        f.registry.write.voidBatch([0n, tree.root, "unknown"], { account: f.owner.account }),
        f.registry,
        "UnknownBatch",
        [0n],
      );
      await viem.assertions.revertWithCustomErrorWithArgs(
        f.registry.write.voidBatch([4n, tree.root, "unknown"], { account: f.owner.account }),
        f.registry,
        "UnknownBatch",
        [4n],
      );

      await viem.assertions.emitWithArgs(
        f.registry.write.voidBatch([1n, tree.root, "service key leaked"], { account: f.owner.account }),
        f.registry,
        "BatchVoided",
        [1n, tree.root, "service key leaked"],
      );
      await viem.assertions.emitWithArgs(
        f.registry.write.voidBatch([2n, leafHash(direct), "bad receipt"], { account: f.owner.account }),
        f.registry,
        "BatchVoided",
        [2n, leafHash(direct), "bad receipt"],
      );

      const voided = await f.registry.read.getBatch([1n]);
      assert.equal(voided.voided, true);
      assert.equal(voided.root, tree.root);
      assert.equal(voided.count, 3);

      for (const receipt of receipts) {
        const proof = tree.proof(leafHash(receipt));
        assert.equal(await f.registry.read.verifyReceipt([1n, asStruct(receipt), proof]), false);
        assert.equal(await f.registry.read.verifyInclusion([1n, leafHash(receipt), proof]), false);
      }
      assert.equal(await f.registry.read.verifyReceipt([2n, asStruct(direct), []]), false);
      assert.equal(await f.registry.read.verifyInclusion([3n, keep, []]), true, "other batches are untouched");

      await viem.assertions.revertWithCustomErrorWithArgs(
        f.registry.write.voidBatch([1n, tree.root, "again"], { account: f.owner.account }),
        f.registry,
        "BatchAlreadyVoided",
        [1n],
      );

      // Spent forever: neither the root nor the direct run can be anchored again.
      assert.equal(await f.registry.read.batchIdOfRoot([tree.root]), 1n);
      await viem.assertions.revertWithCustomErrorWithArgs(
        batchCall(f, { root: tree.root, count: 3 }),
        f.registry,
        "RootAlreadyAttested",
        [tree.root, 1n],
      );
      await viem.assertions.revertWithCustomErrorWithArgs(
        directCall(f, direct),
        f.registry,
        "DuplicateRun",
        [direct.runId, 2n],
      );
    });
  });

  /* ------------------------------------------------------------------------------ */

  describe("service signer rotation", () => {
    it("rejects the zero address and the owner", async () => {
      const f = await load();
      await viem.assertions.revertWithCustomError(
        f.registry.write.setServiceSigner([ZERO_ADDRESS], { account: f.owner.account }),
        f.registry,
        "InvalidServiceSigner",
      );
      await viem.assertions.revertWithCustomError(
        f.registry.write.setServiceSigner([f.owner.account.address], { account: f.owner.account }),
        f.registry,
        "InvalidServiceSigner",
      );
    });

    it("emits ServiceSignerUpdated and stops the old key's signatures at once", async () => {
      const f = await load();
      const root = randomBytes32();
      const deadline = await deadlineIn();
      const oldBatchSig = await signBatchAttestation(f, f.service, { root, count: 1, schemaVersion: 1, deadline });
      const receipt = makeReceipt(f.agent.account.address);
      const oldDirectSig = await signServiceAttestation(f, f.service, receipt, deadline);

      await viem.assertions.emitWithArgs(
        f.registry.write.setServiceSigner([f.newOwner.account.address], { account: f.owner.account }),
        f.registry,
        "ServiceSignerUpdated",
        [getAddress(f.service.account.address), getAddress(f.newOwner.account.address)],
      );
      assert.equal(await f.registry.read.serviceSigner(), getAddress(f.newOwner.account.address));

      await viem.assertions.revertWithCustomError(
        f.registry.write.attestBatch([root, 1, 1, deadline, oldBatchSig], { account: f.relayer.account }),
        f.registry,
        "InvalidServiceSignature",
      );
      await viem.assertions.revertWithCustomError(
        directCall(f, receipt, { deadline, serviceSignature: oldDirectSig }),
        f.registry,
        "InvalidServiceSignature",
      );

      const hash = await batchCall(f, { root, count: 1, deadline }, { signer: f.newOwner });
      await viem.assertions.emitWithArgs(hash, f.registry, "BatchAttested", [
        1n,
        root,
        getAddress(f.newOwner.account.address),
        1,
        1,
      ]);
      assert.equal((await f.registry.read.getBatch([1n])).serviceSigner, getAddress(f.newOwner.account.address));
      await directCall(f, receipt, { deadline, serviceSigner: f.newOwner });
    });
  });

  /* ------------------------------------------------------------------------------ */

  describe("ownership", () => {
    it("restricts every admin function to the owner", async () => {
      const f = await load();
      const root = randomBytes32();
      await batchCall(f, { root, count: 1 });
      const impostor = { account: f.impostor.account };
      const service = { account: f.service.account };
      const calls: Array<[Wallet, () => Promise<Hex>]> = [
        [f.impostor, () => f.registry.write.pause(impostor)],
        [f.impostor, () => f.registry.write.unpause(impostor)],
        [f.impostor, () => f.registry.write.voidBatch([1n, root, "x"], impostor)],
        [f.impostor, () => f.registry.write.setServiceSigner([f.impostor.account.address], impostor)],
        [f.impostor, () => f.registry.write.setSchemaVersionEnabled([2, true], impostor)],
        [f.impostor, () => f.registry.write.transferOwnership([f.impostor.account.address], impostor)],
        [f.impostor, () => f.registry.write.renounceOwnership(impostor)],
        // The service key administers nothing either.
        [f.service, () => f.registry.write.pause(service)],
        [f.service, () => f.registry.write.voidBatch([1n, root, "x"], service)],
        [f.service, () => f.registry.write.setServiceSigner([f.impostor.account.address], service)],
        [f.service, () => f.registry.write.setSchemaVersionEnabled([1, false], service)],
      ];
      for (const [caller, call] of calls) {
        await viem.assertions.revertWithCustomErrorWithArgs(call(), f.registry, "OwnableUnauthorizedAccount", [
          getAddress(caller.account.address),
        ]);
      }
    });

    it("transfers ownership in two steps", async () => {
      const f = await load();
      await viem.assertions.emitWithArgs(
        f.registry.write.transferOwnership([f.newOwner.account.address], { account: f.owner.account }),
        f.registry,
        "OwnershipTransferStarted",
        [getAddress(f.owner.account.address), getAddress(f.newOwner.account.address)],
      );
      assert.equal(await f.registry.read.owner(), getAddress(f.owner.account.address));
      assert.equal(await f.registry.read.pendingOwner(), getAddress(f.newOwner.account.address));

      await viem.assertions.revertWithCustomErrorWithArgs(
        f.registry.write.acceptOwnership({ account: f.impostor.account }),
        f.registry,
        "OwnableUnauthorizedAccount",
        [getAddress(f.impostor.account.address)],
      );
      await viem.assertions.emitWithArgs(
        f.registry.write.acceptOwnership({ account: f.newOwner.account }),
        f.registry,
        "OwnershipTransferred",
        [getAddress(f.owner.account.address), getAddress(f.newOwner.account.address)],
      );
      assert.equal(await f.registry.read.owner(), getAddress(f.newOwner.account.address));
      assert.equal(await f.registry.read.pendingOwner(), ZERO_ADDRESS);

      await viem.assertions.revertWithCustomErrorWithArgs(
        f.registry.write.pause({ account: f.owner.account }),
        f.registry,
        "OwnableUnauthorizedAccount",
        [getAddress(f.owner.account.address)],
      );
      await f.registry.write.pause({ account: f.newOwner.account });
      // The new owner can now never become the service signer, but the old one can.
      await viem.assertions.revertWithCustomError(
        f.registry.write.setServiceSigner([f.newOwner.account.address], { account: f.newOwner.account }),
        f.registry,
        "InvalidServiceSigner",
      );
      await f.registry.write.setServiceSigner([f.owner.account.address], { account: f.newOwner.account });
    });

    it("never hands ownership to the service signer", async () => {
      const f = await load();
      await viem.assertions.revertWithCustomError(
        f.registry.write.transferOwnership([f.service.account.address], { account: f.owner.account }),
        f.registry,
        "InvalidServiceSigner",
      );
      // Rotating the signer onto the pending owner does not sneak past the rule either.
      await f.registry.write.transferOwnership([f.newOwner.account.address], { account: f.owner.account });
      await f.registry.write.setServiceSigner([f.newOwner.account.address], { account: f.owner.account });
      await viem.assertions.revertWithCustomError(
        f.registry.write.acceptOwnership({ account: f.newOwner.account }),
        f.registry,
        "InvalidServiceSigner",
      );
      assert.equal(await f.registry.read.owner(), getAddress(f.owner.account.address));
    });

    it("refuses to renounce ownership", async () => {
      const f = await load();
      await viem.assertions.revertWithCustomError(
        f.registry.write.renounceOwnership({ account: f.owner.account }),
        f.registry,
        "RenounceDisabled",
      );
      assert.equal(await f.registry.read.owner(), getAddress(f.owner.account.address));
    });
  });
});
