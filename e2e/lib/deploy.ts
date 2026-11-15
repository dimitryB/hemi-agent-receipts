import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, http, type Abi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { chainFor, pollTransactionReceipt } from "@hemi-receipts/sdk";

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(here, "../..");
export const ARTIFACT_PATH = resolve(REPO_ROOT, "contracts/artifacts/contracts/ReceiptRegistry.sol/ReceiptRegistry.json");

export function loadRegistryArtifact(): { abi: Abi; bytecode: Hex } {
  if (!existsSync(ARTIFACT_PATH)) {
    execFileSync("npm", ["run", "compile", "-w", "contracts"], { cwd: REPO_ROOT, stdio: "inherit" });
  }
  const artifact = JSON.parse(readFileSync(ARTIFACT_PATH, "utf8"));
  return { abi: artifact.abi as Abi, bytecode: artifact.bytecode as Hex };
}

/** Deploys ReceiptRegistry(owner, serviceSigner) from `deployerKey`. Returns address and block. */
export async function deployRegistry(input: {
  rpcUrl: string;
  chainId: number;
  deployerKey: Hex;
  owner: Address;
  serviceSigner: Address;
}): Promise<{ registry: Address; deployBlock: bigint; txHash: Hex }> {
  const { abi, bytecode } = loadRegistryArtifact();
  const chain = chainFor(input.chainId, [input.rpcUrl]);
  const account = privateKeyToAccount(input.deployerKey);
  const wallet = createWalletClient({ account, chain, transport: http(input.rpcUrl) });
  const client = createPublicClient({ chain, transport: http(input.rpcUrl) });
  const txHash = await wallet.deployContract({ abi, bytecode, args: [input.owner, input.serviceSigner] });
  const receipt = await pollTransactionReceipt(client as never, txHash, { timeoutMs: 600_000, intervalMs: 200 });
  if (!receipt.contractAddress || receipt.status !== "success") throw new Error(`deploy failed: ${txHash}`);
  return { registry: receipt.contractAddress, deployBlock: receipt.blockNumber, txHash };
}
