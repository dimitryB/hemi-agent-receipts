/**
 * Gas used by the two anchoring functions, read from transaction receipts (production
 * build profile: optimizer on, 200 runs). The numbers go in contracts/README.md; the bounds
 * below are loose regression guards, not targets.
 */
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { keccak256, stringToHex, type Hex } from "viem";
import { network } from "hardhat";
import type { ReceiptFields } from "@hemi-receipts/sdk";
import {
  asStruct,
  deployRegistry,
  signBatchAttestation,
  signReceiptWith,
  signServiceAttestation,
  type Fixture,
  type Wallet,
} from "./helpers.js";

const label = (text: string): Hex => keccak256(stringToHex(text));

describe("gas", async () => {
  const { viem, networkHelpers } = await network.create();
  const rows: Array<[string, bigint]> = [];

  after(() => {
    console.log("\n  | Call | gasUsed |\n  |------|--------:|");
    for (const [what, gas] of rows) console.log(`  | ${what} | ${gas.toLocaleString("en-US")} |`);
    console.log();
  });

  async function deadline(): Promise<bigint> {
    return BigInt(await networkHelpers.time.latest()) + 600n;
  }

  async function batch(f: Fixture, name: string, count: number) {
    const root = label(name);
    const d = await deadline();
    const sig = await signBatchAttestation(f, f.service, { root, count, schemaVersion: 1, deadline: d });
    const hash = await f.registry.write.attestBatch([root, count, 1, d, sig], { account: f.relayer.account });
    return (await f.publicClient.waitForTransactionReceipt({ hash })).gasUsed;
  }

  async function direct(f: Fixture, receipt: ReceiptFields, signer: Wallet) {
    const d = await deadline();
    const agentSig = await signReceiptWith(f, signer, receipt);
    const serviceSig = await signServiceAttestation(f, f.service, receipt, d);
    const hash = await f.registry.write.attest([asStruct(receipt), agentSig, d, serviceSig], {
      account: f.relayer.account,
    });
    return (await f.publicClient.waitForTransactionReceipt({ hash })).gasUsed;
  }

  function receipt(name: string, agent: Hex, principal: Hex = agent): ReceiptFields {
    return {
      runId: label(`run-${name}`),
      manifestHash: label(`manifest-${name}`),
      agent: agent.toLowerCase() as Hex,
      principal: principal.toLowerCase() as Hex,
      schemaVersion: 1,
    };
  }

  it("attestBatch", async () => {
    const f = await deployRegistry(viem);
    const first = await batch(f, "batch-1", 1_000);
    const steady = await batch(f, "batch-2", 1_000);
    rows.push(["attestBatch, first batch on a new registry", first]);
    rows.push(["attestBatch, any later batch (any count)", steady]);
    assert.ok(steady < 140_000n, `attestBatch used ${steady}`);
  });

  it("attest", async () => {
    const f = await deployRegistry(viem);
    const wallet = await viem.deployContract("ERC1271WalletMock", [f.other.account.address]);
    const agent = f.agent.account.address;
    const principal = f.principal.account.address;

    const first = await direct(f, receipt("a", agent, principal), f.agent);
    const byAgent = await direct(f, receipt("b", agent, principal), f.agent);
    const byPrincipal = await direct(f, receipt("c", agent, principal), f.principal);
    const by1271 = await direct(f, receipt("d", wallet.address, principal), f.other);
    rows.push(["attest, first receipt on a new registry (agent-signed)", first]);
    rows.push(["attest, signed by the agent (EOA)", byAgent]);
    rows.push(["attest, signed by the principal (EOA)", byPrincipal]);
    rows.push(["attest, agent is an EIP-1271 wallet", by1271]);
    assert.ok(byAgent < 185_000n, `attest used ${byAgent}`);
  });
});
