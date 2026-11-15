/**
 * One-shot ReceiptRegistry deployer for the docker-compose `local` profile (offline demo on
 * anvil). LOCAL CHAINS ONLY: it refuses any chain id other than 31337.
 *
 *   RPC_URL                 default http://anvil:8545
 *   ARTIFACT                default /artifacts/contracts/ReceiptRegistry.sol/ReceiptRegistry.json
 *                           (bind-mounted from contracts/artifacts; run `npm run compile -w contracts` first)
 *   DEPLOYER_PRIVATE_KEY    the owner; anvil's account 0 in the compose file
 *   SERVICE_SIGNER          the service signer address; anvil's account 1 in the compose file
 *   EXPECTED_ADDRESS        optional; where the registry must end up (fresh anvil, nonce 0)
 *
 * Idempotent: if EXPECTED_ADDRESS already has code, it does nothing.
 */
import { readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, getAddress, http, isAddressEqual, type Abi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { chainFor, pollTransactionReceipt } from "@hemi-receipts/sdk";

function fail(message: string): never {
  console.error(`[deploy-local] ${message}`);
  process.exit(1);
}

const rpcUrl = process.env.RPC_URL ?? "http://anvil:8545";
const artifactPath = process.env.ARTIFACT ?? "/artifacts/contracts/ReceiptRegistry.sol/ReceiptRegistry.json";
const key = process.env.DEPLOYER_PRIVATE_KEY as Hex | undefined;
const signer = process.env.SERVICE_SIGNER;
const expected = process.env.EXPECTED_ADDRESS ? getAddress(process.env.EXPECTED_ADDRESS) : undefined;
if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) fail("DEPLOYER_PRIVATE_KEY must be a 0x-prefixed 32-byte hex key");
if (!signer) fail("SERVICE_SIGNER is required");

const probe = createPublicClient({ transport: http(rpcUrl) });
let chainId = 0;
for (let attempt = 0; ; attempt++) {
  try {
    chainId = await probe.getChainId();
    break;
  } catch {
    if (attempt >= 60) fail(`no RPC at ${rpcUrl}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}
if (chainId !== 31337) fail(`refusing to deploy to chain ${chainId}: this tool is for the local anvil (31337) only`);

const chain = chainFor(chainId, [rpcUrl]);
const client = createPublicClient({ chain, transport: http(rpcUrl) });
if (expected) {
  const code = await client.getCode({ address: expected });
  if (code && code !== "0x") {
    console.log(`[deploy-local] ReceiptRegistry already at ${expected}`);
    process.exit(0);
  }
}

let artifact: { abi: Abi; bytecode: Hex };
try {
  artifact = JSON.parse(readFileSync(artifactPath, "utf8"));
} catch {
  fail(`cannot read ${artifactPath}; run \`npm run compile -w contracts\` on the host first`);
}
const account = privateKeyToAccount(key);
const wallet = createWalletClient({ account, chain, transport: http(rpcUrl) });
const hash = await wallet.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode, args: [account.address, getAddress(signer)] });
const receipt = await pollTransactionReceipt(client as never, hash, { intervalMs: 250 });
if (receipt.status !== "success" || !receipt.contractAddress) fail(`deployment failed: ${hash}`);
const address: Address = getAddress(receipt.contractAddress);
if (expected && !isAddressEqual(expected, address)) fail(`deployed to ${address}, expected ${expected} (was the anvil fresh?)`);
console.log(`[deploy-local] ReceiptRegistry deployed at ${address} in block ${receipt.blockNumber} (owner ${account.address}, serviceSigner ${getAddress(signer)})`);
