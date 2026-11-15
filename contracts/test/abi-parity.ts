/**
 * sdk/src/abi.ts was written by hand from docs/SCHEMA.md §5. This checks it against the
 * compiled ReceiptRegistry artifact in both directions, comparing names, types, struct
 * components, `indexed` flags, outputs and state mutability, so any drift fails here.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Abi, AbiParameter } from "viem";
import hre from "hardhat";
import { receiptRegistryAbi } from "@hemi-receipts/sdk";

type Item = Extract<Abi[number], { type: "function" | "event" | "error" }>;

/**
 * Artifact entries that are allowed to be absent from the SDK ABI, each with the reason.
 * Keep this list short and explicit; everything else must match.
 */
const NOT_NEEDED_IN_SDK: Record<string, string> = {};

function canonicalType(param: AbiParameter): string {
  if (param.type.startsWith("tuple")) {
    const components = (param as { components: readonly AbiParameter[] }).components;
    return `(${components.map(canonicalType).join(",")})${param.type.slice("tuple".length)}`;
  }
  return param.type;
}

function signature(item: Item): string {
  return `${item.type} ${item.name}(${item.inputs.map(canonicalType).join(",")})`;
}

/** Drops internalType and fills in defaults so hand-written and compiled ABIs compare equal. */
function normalizeParam(param: AbiParameter, withIndexed: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = { name: param.name ?? "", type: param.type };
  if (withIndexed) out.indexed = (param as { indexed?: boolean }).indexed ?? false;
  if ("components" in param && param.components) {
    out.components = param.components.map((c) => normalizeParam(c, false));
  }
  return out;
}

function normalize(item: Item): Record<string, unknown> {
  const isEvent = item.type === "event";
  const out: Record<string, unknown> = {
    type: item.type,
    name: item.name,
    inputs: item.inputs.map((p) => normalizeParam(p, isEvent)),
  };
  if (item.type === "function") {
    out.outputs = item.outputs.map((p) => normalizeParam(p, false));
    out.stateMutability = item.stateMutability;
  }
  if (item.type === "event") out.anonymous = item.anonymous ?? false;
  return out;
}

function index(abi: Abi): Map<string, Item> {
  const map = new Map<string, Item>();
  for (const entry of abi) {
    if (entry.type !== "function" && entry.type !== "event" && entry.type !== "error") continue;
    const key = signature(entry);
    assert.ok(!map.has(key), `duplicate ABI entry ${key}`);
    map.set(key, entry);
  }
  return map;
}

describe("ABI parity: sdk/src/abi.ts ↔ compiled ReceiptRegistry", async () => {
  const artifact = await hre.artifacts.readArtifact("ReceiptRegistry");
  const compiled = index(artifact.abi as Abi);
  const sdk = index(receiptRegistryAbi as Abi);

  it("every SDK function, event and error exists in the artifact with identical inputs and outputs", () => {
    const missing: string[] = [];
    for (const [key, item] of sdk) {
      const match = compiled.get(key);
      if (!match) {
        missing.push(key);
        continue;
      }
      assert.deepEqual(normalize(item), normalize(match), `${key} differs between the SDK ABI and the artifact`);
    }
    assert.deepEqual(missing, [], "in the SDK ABI but not in the contract");
  });

  it("every external function, event and error of the artifact is in the SDK ABI", () => {
    const missing = [...compiled.keys()].filter((key) => !sdk.has(key) && !(key in NOT_NEEDED_IN_SDK));
    assert.deepEqual(missing, [], "in the contract but not in the SDK ABI");
  });

  it("the allow-list (empty: the SDK ABI is complete) only names entries that really exist in the artifact", () => {
    for (const key of Object.keys(NOT_NEEDED_IN_SDK)) {
      assert.ok(compiled.has(key), `stale NOT_NEEDED_IN_SDK entry: ${key}`);
    }
  });

  it("the constructor is (address initialOwner, address initialServiceSigner)", () => {
    const ctor = (artifact.abi as Abi).find((entry) => entry.type === "constructor");
    assert.ok(ctor && ctor.type === "constructor");
    assert.deepEqual(
      ctor.inputs.map((p) => `${p.type} ${p.name}`),
      ["address initialOwner", "address initialServiceSigner"],
    );
    assert.equal(ctor.stateMutability, "nonpayable");
  });
});
