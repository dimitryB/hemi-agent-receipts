/**
 * Read-only preflight for scripts/mainnet-smoke.sh. Reads the service settings and the buyer's key
 * file in-process (keys are never printed), then checks the chain and the facilitator.
 *
 *   node scripts/mainnet-smoke-check.mjs .secrets/mainnet.env .secrets/mainnet-agent.json
 *
 * Exits 1 with every problem listed, 0 when the paid run can start. Sends no transaction.
 */
import { readFileSync } from "node:fs";
import { createPublicClient, formatEther, formatUnits, getAddress, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const [envPath, agentPath] = process.argv.slice(2);
if (!envPath || !agentPath) {
  console.error("usage: node scripts/mainnet-smoke-check.mjs <service env file> <buyer key file>");
  process.exit(2);
}
const env = Object.fromEntries(
  readFileSync(envPath, "utf8")
    .split("\n")
    .filter((line) => /^[A-Z0-9_]+=/.test(line))
    .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1).trim()]),
);
const agentData = JSON.parse(readFileSync(agentPath, "utf8")).data;
const agent = privateKeyToAccount((Array.isArray(agentData) ? agentData[0] : agentData).private_key).address;
const signer = privateKeyToAccount(env.SERVICE_PRIVATE_KEY).address;
const relayer = privateKeyToAccount(env.RELAYER_PRIVATE_KEY ?? env.SERVICE_PRIVATE_KEY).address;

const CHAIN_ID = Number(env.CHAIN_ID);
const REGISTRY = getAddress(env.REGISTRY_ADDRESS);
const PAY_TO = getAddress(env.PAY_TO);
const USDC = "0xad11a8BEb98bbf61dbb1aa0F6d6F2ECD87b35afA"; // DECISIONS.md D-7; the service's mainnet default
const PRICE = BigInt(env.PRICE_BATCH ?? "1000");
const RECEIPTS = 3n;
const MIN_RELAYER_WEI = 500_000_000_000_000n; // 0.0005 ETH
const NETWORK = `eip155:${CHAIN_ID}`;

const client = createPublicClient({ transport: http(env.HEMI_RPC_URLS.split(",")[0].trim(), { retryCount: 4, retryDelay: 1500, timeout: 15000 }) });
const registryAbi = parseAbi([
  "function owner() view returns (address)",
  "function serviceSigner() view returns (address)",
  "function paused() view returns (bool)",
  "function schemaVersionEnabled(uint16) view returns (bool)",
]);
const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);
const problems = [];
const row = (label, value, ok = true) => {
  console.log(`${ok ? "ok " : "!! "} ${label.padEnd(26)} ${value}`);
  if (!ok) problems.push(`${label}: ${value}`);
};

const chainId = await client.getChainId();
row("RPC chain id", chainId, chainId === CHAIN_ID && CHAIN_ID === 43111);

const code = await client.getCode({ address: REGISTRY });
row("registry", `${REGISTRY} (${code ? (code.length - 2) / 2 + " bytes" : "no code"})`, Boolean(code));
if (code) {
  const read = (functionName, args = []) => client.readContract({ address: REGISTRY, abi: registryAbi, functionName, args });
  const [owner, onchainSigner, paused, schema1] = await Promise.all([read("owner"), read("serviceSigner"), read("paused"), read("schemaVersionEnabled", [1])]);
  row("registry owner", owner);
  row("registry serviceSigner", `${onchainSigner} (the env's key: ${signer})`, onchainSigner === signer);
  row("registry paused", paused, paused === false);
  row("schema version 1 enabled", schema1, schema1 === true);
  const ownerCode = await client.getCode({ address: owner });
  row("owner has code (a Safe)", ownerCode ? "yes" : "no", Boolean(ownerCode));
}
const payToCode = await client.getCode({ address: PAY_TO });
row("PAY_TO", `${PAY_TO} (${payToCode ? "contract" : "plain address"})`);

const relayerWei = await client.getBalance({ address: relayer });
row("relayer ETH", `${relayer} ${formatEther(relayerWei)} (needs ≥ ${formatEther(MIN_RELAYER_WEI)})`, relayerWei >= MIN_RELAYER_WEI);
const agentUsdc = await client.readContract({ address: USDC, abi: erc20, functionName: "balanceOf", args: [agent] });
row("buyer USDC.e", `${agent} ${formatUnits(agentUsdc, 6)} (needs ≥ ${formatUnits(PRICE * RECEIPTS, 6)})`, agentUsdc >= PRICE * RECEIPTS);
const payToUsdc = await client.readContract({ address: USDC, abi: erc20, functionName: "balanceOf", args: [PAY_TO] });
row("PAY_TO USDC.e now", formatUnits(payToUsdc, 6));
row("gas price", `${Number(await client.getGasPrice()) / 1e9} gwei`);

const facilitator = env.FACILITATOR_URL ?? "http://localhost:8080";
try {
  const res = await fetch(`${facilitator}/supported`, { signal: AbortSignal.timeout(5000) });
  const body = await res.json();
  const kind = (body.kinds ?? []).find((k) => k.network === NETWORK && k.scheme === "exact");
  const signers = body.signers?.[NETWORK] ?? [];
  row("facilitator", `${facilitator} serves ${NETWORK} exact: ${kind ? "yes" : "no"}; signer ${signers.join(", ") || "none"}`, Boolean(kind));
} catch (error) {
  row("facilitator", `${facilitator} does not answer (${error.cause?.code ?? error.message}). Start it in ../x402facilitator: FACILITATOR_CONFIG=config.mainnet.json docker compose up -d`, false);
}

if (problems.length) {
  console.error(`\npreflight failed (${problems.length}); nothing was sent.`);
  process.exit(1);
}
console.log("\npreflight passed; nothing was sent.");
