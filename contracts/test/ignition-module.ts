import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { getAddress } from "viem";
import { network } from "hardhat";
import ReceiptRegistryModule from "../ignition/modules/ReceiptRegistry.js";

describe("Ignition module ReceiptRegistryModule", async () => {
  const { ignition, viem } = await network.create();

  it("deploys ReceiptRegistry(owner, serviceSigner) from its parameters", async () => {
    const [, owner, serviceSigner] = await viem.getWalletClients();
    const { registry } = await ignition.deploy(ReceiptRegistryModule, {
      parameters: {
        ReceiptRegistryModule: { owner: owner!.account.address, serviceSigner: serviceSigner!.account.address },
      },
    });
    assert.equal(await registry.read.owner(), getAddress(owner!.account.address));
    assert.equal(await registry.read.serviceSigner(), getAddress(serviceSigner!.account.address));
    assert.equal(await registry.read.schemaVersionEnabled([1]), true);
  });

  it("the example parameter files name exactly the module's parameters", () => {
    for (const file of ["hemi-testnet.example.json", "hemi-mainnet.example.json"]) {
      const parsed = JSON.parse(readFileSync(new URL(`../ignition/parameters/${file}`, import.meta.url), "utf8"));
      assert.deepEqual(Object.keys(parsed), ["ReceiptRegistryModule"], file);
      assert.deepEqual(Object.keys(parsed.ReceiptRegistryModule).sort(), ["owner", "serviceSigner"], file);
    }
  });
});
