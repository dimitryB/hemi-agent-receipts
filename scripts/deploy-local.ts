/**
 * Deploys ReceiptRegistry on a LOCAL chain (anvil or an anvil fork) with anvil's public dev
 * keys: owner #0, service signer #1, deployer #0. Prints `address deployBlock`.
 *   npx tsx scripts/deploy-local.ts http://127.0.0.1:8545
 * Refuses any RPC that is not on localhost.
 */
import { createPublicClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ANVIL_KEYS, ROLE, deployRegistry } from "../e2e/lib/index.js";

const rpcUrl = process.argv[2] ?? "http://127.0.0.1:8545";
const host = new URL(rpcUrl).hostname;
if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(host)) {
  console.error(`refusing to deploy with dev keys to non-local RPC ${rpcUrl}`);
  process.exit(2);
}
const chainId = await createPublicClient({ transport: http(rpcUrl) }).getChainId();
const { registry, deployBlock } = await deployRegistry({
  rpcUrl,
  chainId,
  deployerKey: ANVIL_KEYS[ROLE.owner]!,
  owner: privateKeyToAccount(ANVIL_KEYS[ROLE.owner]!).address,
  serviceSigner: privateKeyToAccount(ANVIL_KEYS[ROLE.service]!).address,
});
console.log(`${registry} ${deployBlock}`);
