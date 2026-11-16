import { it } from "node:test";
import assert from "node:assert/strict";
import { encodeFunctionData, recoverTypedDataAddress, toFunctionSelector, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { batchAttestationTypedData, receiptDigest, receiptRegistryAbi, registryDomain, serviceAttestationTypedData } from "@hemi-receipts/sdk";
import { mine } from "@hemi-receipts/e2e/lib";
import type { RunningService } from "../src/service.js";
import { accounts, makeManifest, post, setupChain, signed, startTestService, tempDbPath, testEnv } from "./helpers.js";

it("after the service signer is rotated, work signed by the old key is re-signed by the new one: the batch anchors, a direct resubmission gets calldata that does not revert", { timeout: 60_000 }, async () => {
  const chain = await setupChain();
  const db = tempDbPath();
  let service: RunningService | undefined;
  const env = (extra: Record<string, string> = {}) => testEnv(chain, db.path, { BATCH_MAX_SIZE: "1", ...extra });
  const domain = registryDomain(chain.anvil.chainId, chain.registry);
  try {
    // Under the old key: one batch closed and signed but not sent, and one direct attestation issued.
    service = await startTestService(env(), { loops: false });
    const batched = await signed(chain, makeManifest());
    assert.equal((await post(`${service.url}/attest`, { manifest: batched.manifest, agentSignature: batched.agentSignature })).status, 202);
    await service.batcher.tick(); // close: signed by the old key
    const before = (await service.store.getBatch(1))!;
    assert.equal(before.state, "signed");
    const direct = await signed(chain, makeManifest());
    const directRequest = { manifest: direct.manifest, agentSignature: direct.agentSignature };
    const issued = await post(`${service.url}/attest/direct`, directRequest);
    assert.equal(issued.status, 202, JSON.stringify(issued.body));
    await service.stop();
    service = undefined;

    // The owner rotates the registry's signer, and the service restarts with the new key.
    const newKey = generatePrivateKey();
    const newSigner = privateKeyToAccount(newKey).address;
    const rotate = await chain.client.request({
      method: "eth_sendTransaction",
      params: [{ from: accounts.owner.address, to: chain.registry, data: encodeFunctionData({ abi: receiptRegistryAbi, functionName: "setServiceSigner", args: [newSigner] }) }],
    } as never);
    await chain.client.waitForTransactionReceipt({ hash: rotate as Hex });
    service = await startTestService(env({ SERVICE_PRIVATE_KEY: newKey }), { loops: false });

    // The batch is re-signed by the new key before it is sent, and anchors.
    await service.batcher.tick(); // send
    const sent = (await service.store.getBatch(1))!;
    assert.equal(sent.state, "sent", sent.last_error ?? "");
    const signer = await recoverTypedDataAddress({
      ...batchAttestationTypedData({ root: sent.root, count: sent.count, schemaVersion: sent.schema_version, deadline: BigInt(sent.deadline!) }, domain),
      signature: sent.service_signature as Hex,
    });
    assert.equal(signer.toLowerCase(), newSigner.toLowerCase());
    await mine(chain.anvil.url, 3);
    await service.store.updateBatch(1, { next_attempt_at: 0 }, Date.now());
    await service.batcher.tick(); // mined
    assert.equal((await service.store.getBatch(1))!.state, "mined");

    // A direct resubmission gets a signature by the new key (no charge), and its calldata goes through.
    const again = await post(`${service.url}/attest/direct`, directRequest);
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.notEqual(again.body.serviceSignature, issued.body.serviceSignature);
    const directSigner = await recoverTypedDataAddress({
      ...serviceAttestationTypedData(receiptDigest(direct.receipt, domain), BigInt(again.body.deadline), domain),
      signature: again.body.serviceSignature as Hex,
    });
    assert.equal(directSigner.toLowerCase(), newSigner.toLowerCase());
    await chain.client.call({ account: accounts.agent.address, to: again.body.to as Hex, data: again.body.data as Hex }); // throws on a revert
    await assert.rejects(
      chain.client.call({ account: accounts.agent.address, to: issued.body.to as Hex, data: issued.body.data as Hex }),
      new RegExp(toFunctionSelector("InvalidServiceSignature()")),
      "the old key's calldata is refused (InvalidServiceSignature), which is why it is re-issued",
    );
  } finally {
    await service?.stop();
    await chain.stop();
    db.cleanup();
  }
});
