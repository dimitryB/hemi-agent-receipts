import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { createPublicClient, http, type Address, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { chainFor, contentHash, newRunId, receiptFromManifest, registryDomain, signReceipt, type ManifestV1, type ReceiptFields } from "@hemi-receipts/sdk";
import { ANVIL_KEYS, deployRegistry, ROLE, startAnvil, type Anvil } from "@hemi-receipts/e2e/lib";
import { loadConfig, type Config } from "../src/config.js";
import { createLogger, silentLogger, type Logger } from "../src/log.js";
import { startService, type RunningService, type ServiceOptions } from "../src/service.js";

export const accounts = {
  owner: privateKeyToAccount(ANVIL_KEYS[ROLE.owner]!),
  service: privateKeyToAccount(ANVIL_KEYS[ROLE.service]!),
  relayer: privateKeyToAccount(ANVIL_KEYS[ROLE.relayer]!),
  agent: privateKeyToAccount(ANVIL_KEYS[ROLE.agent]!),
  principal: privateKeyToAccount(ANVIL_KEYS[ROLE.principal]!),
  stranger: privateKeyToAccount(ANVIL_KEYS[ROLE.stranger]!),
};

export interface TestChain {
  anvil: Anvil;
  registry: Address;
  deployBlock: bigint;
  client: PublicClient;
  stop(): Promise<void>;
}

/** A fresh anvil with a ReceiptRegistry(owner, service) deployed. */
export async function setupChain(options: { chainId?: number; blockTime?: number } = {}): Promise<TestChain> {
  const anvil = await startAnvil(options);
  try {
    const { registry, deployBlock } = await deployRegistry({
      rpcUrl: anvil.url,
      chainId: anvil.chainId,
      deployerKey: ANVIL_KEYS[ROLE.owner]!,
      owner: accounts.owner.address,
      serviceSigner: accounts.service.address,
    });
    const client = createPublicClient({ chain: chainFor(anvil.chainId, [anvil.url]), transport: http(anvil.url) }) as PublicClient;
    return { anvil, registry, deployBlock, client, stop: () => anvil.stop() };
  } catch (error) {
    await anvil.stop();
    throw error;
  }
}

export function tempDbPath(): { path: string; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), "receipts-service-test-"));
  return { path: join(dir, "receipts.sqlite"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Environment for a service against `chain`, fast intervals, free unless overridden. */
export function testEnv(chain: TestChain, dbPath: string, overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    CHAIN_ID: String(chain.anvil.chainId),
    HEMI_RPC_URLS: chain.anvil.url,
    REGISTRY_ADDRESS: chain.registry,
    REGISTRY_DEPLOY_BLOCK: String(chain.deployBlock),
    SERVICE_PRIVATE_KEY: ANVIL_KEYS[ROLE.service],
    RELAYER_PRIVATE_KEY: ANVIL_KEYS[ROLE.relayer],
    DB_PATH: dbPath,
    HOST: "127.0.0.1",
    PORT: "0",
    DEV_FREE: "1",
    BATCH_MAX_SIZE: "64",
    BATCH_MAX_WAIT_SECONDS: "1",
    HEMI_CONFIRMATIONS: "3",
    POLL_INTERVAL_SECONDS: "0.2",
    RPC_REQUESTS_PER_SECOND: "200",
    RPC_BURST: "200",
    RPC_RETRY_DELAY_MS: "50",
    LOG_LEVEL: process.env.TEST_LOG_LEVEL ?? "silent",
    ...overrides,
  };
}

export function testLogger(): Logger {
  const level = process.env.TEST_LOG_LEVEL;
  return level ? createLogger(level as "debug") : silentLogger;
}

/** A logger that keeps its lines, for tests of what an operator gets told. */
export function recordingLogger(): Logger & { lines: string[] } {
  const lines: string[] = [];
  return Object.assign(createLogger("info", (line) => lines.push(line)), { lines });
}

export async function startTestService(env: Record<string, string | undefined>, options: ServiceOptions = {}): Promise<RunningService> {
  const config: Config = loadConfig(env);
  return startService(config, { log: testLogger(), ...options });
}

const CRASH_CHILD = fileURLToPath(new URL("./fixtures/crash-child.ts", import.meta.url));
const SERVICE_DIR = fileURLToPath(new URL("..", import.meta.url));

/** Starts the service in a child that SIGKILLs itself at `crashAt` ("none": at the test's `kill`); resolves with its URL and exit. */
export async function startCrashingChild(env: Record<string, string | undefined>, crashAt: string) {
  const child = spawn(process.execPath, ["--import", "tsx", CRASH_CHILD], {
    cwd: SERVICE_DIR,
    env: { ...process.env, ...env, CRASH_AT: crashAt } as NodeJS.ProcessEnv,
    stdio: ["ignore", "pipe", "inherit"],
  });
  const exited = once(child, "exit") as Promise<[number | null, NodeJS.Signals | null]>;
  const lines = createInterface({ input: child.stdout! });
  const first = await Promise.race([
    once(lines, "line").then(([line]) => line as string),
    exited.then(([code, signal]) => {
      throw new Error(`child exited early (${code ?? signal})`);
    }),
  ]);
  return { url: (JSON.parse(first) as { url: string }).url, exited, kill: () => child.kill("SIGKILL") };
}

/** A valid v1 manifest by the agent, with a fresh run id. */
export function makeManifest(overrides: Partial<ManifestV1> = {}): ManifestV1 {
  return {
    receiptVersion: 1,
    runId: newRunId(),
    agent: accounts.agent.address.toLowerCase() as Address,
    principal: accounts.principal.address.toLowerCase() as Address,
    startedAt: 1_793_300_000,
    endedAt: 1_793_300_042,
    model: "claude-fable-5-1",
    promptHash: contentHash("prompt"),
    outputHash: contentHash(`output ${Math.random()}`),
    toolCalls: [{ name: "web_search", argsHash: contentHash("args"), resultHash: contentHash("result"), at: 1_793_300_010 }],
    spend: [{ asset: "usd", amount: "0.0042" }],
    ...overrides,
  };
}

/** The agent (by default) signs the manifest's receipt for this registry. */
export async function signed(
  chain: { anvil: { chainId: number }; registry: Address },
  manifest: ManifestV1,
  signerKey: Hex = ANVIL_KEYS[ROLE.agent]!,
): Promise<{ manifest: ManifestV1; receipt: ReceiptFields; agentSignature: Hex }> {
  const receipt = receiptFromManifest(manifest);
  const agentSignature = await signReceipt(privateKeyToAccount(signerKey), receipt, registryDomain(chain.anvil.chainId, chain.registry));
  return { manifest, receipt, agentSignature };
}

export interface HttpResult<T = any> {
  status: number;
  body: T;
  headers: Headers;
}

export async function post<T = any>(url: string, body: unknown, headers: Record<string, string> = {}): Promise<HttpResult<T>> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
}

export async function get<T = any>(url: string): Promise<HttpResult<T>> {
  const res = await fetch(url);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
}

export async function waitFor<T>(what: string, fn: () => Promise<T | undefined | null | false>, timeoutMs = 20_000, intervalMs = 100): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  for (;;) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}${last ? `: ${(last as Error).message}` : ""}`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/** Transactions the relayer has had mined (its confirmed nonce). */
export async function relayerTxCount(chain: TestChain): Promise<number> {
  return chain.client.getTransactionCount({ address: accounts.relayer.address, blockTag: "latest" });
}

export async function batchCount(chain: TestChain): Promise<bigint> {
  const { receiptRegistryAbi } = await import("@hemi-receipts/sdk");
  return chain.client.readContract({ address: chain.registry, abi: receiptRegistryAbi, functionName: "batchCount" });
}
