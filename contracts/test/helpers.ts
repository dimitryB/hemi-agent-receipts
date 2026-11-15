/**
 * Shared fixture and signing helpers for the ReceiptRegistry tests. Not a test file itself:
 * the Hardhat node:test runner loads it, finds no tests and moves on.
 *
 * Signing deliberately goes through the SDK's typed-data builders, so every passing test is
 * also evidence that the SDK and the contract agree on the EIP-712 structs and domain.
 */
import { randomBytes } from "node:crypto";
import { bytesToHex, type Address, type Hex } from "viem";
import {
  batchAttestationTypedData,
  leafHash,
  receiptDigest,
  receiptTypedData,
  registryDomain,
  serviceAttestationTypedData,
  type ReceiptFields,
} from "@hemi-receipts/sdk";
import type { network } from "hardhat";

export type Connection = Awaited<ReturnType<typeof network.create>>;
export type Viem = Connection["viem"];
export type Wallet = Awaited<ReturnType<Viem["getWalletClients"]>>[number];

export const ZERO_HASH = `0x${"0".repeat(64)}` as Hex;
export const ZERO_ADDRESS = `0x${"0".repeat(40)}` as Address;
export const MAX_DEADLINE_WINDOW = 3_600n;
export const MAX_BATCH_COUNT = 65_536;

export function randomBytes32(): Hex {
  return bytesToHex(randomBytes(32));
}

/** Lowercases addresses, as a manifest spells them (docs/SCHEMA.md §1.2). */
export function makeReceipt(agent: Address, principal: Address = agent, schemaVersion = 1): ReceiptFields {
  return {
    runId: randomBytes32(),
    manifestHash: randomBytes32(),
    agent: agent.toLowerCase() as Address,
    principal: principal.toLowerCase() as Address,
    schemaVersion,
  };
}

/** Contract-call shape of a receipt (schemaVersion as a number, as viem expects for uint16). */
export function asStruct(receipt: ReceiptFields) {
  return {
    runId: receipt.runId,
    manifestHash: receipt.manifestHash,
    agent: receipt.agent,
    principal: receipt.principal,
    schemaVersion: receipt.schemaVersion,
  } as const;
}

export { leafHash };

export async function deployRegistry(viem: Viem) {
  const [owner, service, agent, principal, relayer, impostor, newOwner, other] = await viem.getWalletClients();
  const registry = await viem.deployContract("ReceiptRegistry", [owner!.account.address, service!.account.address]);
  const publicClient = await viem.getPublicClient();
  const chainId = await publicClient.getChainId();
  const domain = registryDomain(chainId, registry.address);
  return {
    registry,
    publicClient,
    chainId,
    domain,
    owner: owner!,
    service: service!,
    agent: agent!,
    principal: principal!,
    relayer: relayer!,
    impostor: impostor!,
    newOwner: newOwner!,
    other: other!,
  };
}

export type Fixture = Awaited<ReturnType<typeof deployRegistry>>;

export async function signReceiptWith(fixture: Fixture, signer: Wallet, receipt: ReceiptFields): Promise<Hex> {
  return signer.signTypedData({ ...receiptTypedData(receipt, fixture.domain), account: signer.account });
}

/** The service's ServiceAttestation over the agent's FULL digest. */
export async function signServiceAttestation(
  fixture: Fixture,
  signer: Wallet,
  receipt: ReceiptFields,
  deadline: bigint,
): Promise<Hex> {
  const digest = receiptDigest(receipt, fixture.domain);
  return signer.signTypedData({
    ...serviceAttestationTypedData(digest, deadline, fixture.domain),
    account: signer.account,
  });
}

export async function signBatchAttestation(
  fixture: Fixture,
  signer: Wallet,
  batch: { root: Hex; count: number; schemaVersion: number; deadline: bigint },
): Promise<Hex> {
  return signer.signTypedData({ ...batchAttestationTypedData(batch, fixture.domain), account: signer.account });
}
