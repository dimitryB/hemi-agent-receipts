/**
 * Definition-of-done, end to end, on a local chain with a flaky RPC in front of it.
 *
 * Runs the real binaries (service/dist and cli/dist), exactly as the README tells a user to:
 *  1. three manifests attested together land in ONE BatchAttested tx and reach hemi-confirmed;
 *  2. resubmitting an identical manifest returns the original receipt with no new tx;
 *     a different manifest with a reused runId is rejected;
 *  3. the service is killed, then `receipts verify` (RPC + registry only) says valid for a real
 *     receipt, and invalid with a reason for (a) one changed manifest byte, (b) a proof against
 *     the wrong batch, (c) a forged agent signature;
 *  4. without DEV_FREE, POST /attest answers 402 with x402 payment requirements.
 * Every chain call of the service and of verify goes through startFlakyRpc.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  createPublicClient,
  http,
  parseEventLogs,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  chainFor,
  newRunId,
  normalizeManifest,
  PaymentRequiredError,
  receiptFromManifest,
  receiptRegistryAbi,
  registryDomain,
  signReceipt,
  submit,
  type ReceiptFile,
} from "@hemi-receipts/sdk";
import {
  ANVIL_KEYS,
  DEFAULT_MODES,
  deployRegistry,
  freePort,
  mine,
  REPO_ROOT,
  ROLE,
  startAnvil,
  startFlakyRpc,
  type Anvil,
  type FlakyRpc,
} from "../lib/index.js";

const run = promisify(execFile);
const CLI = resolve(REPO_ROOT, "cli/dist/index.js");
const SERVICE = resolve(REPO_ROOT, "service/dist/index.js");
const DEMOS = [1, 2, 3].map((n) => resolve(REPO_ROOT, `examples/manifests/demo-${n}.json`));
const agentKey = ANVIL_KEYS[ROLE.agent]!;
const agent = privateKeyToAccount(agentKey);
const stranger = privateKeyToAccount(ANVIL_KEYS[ROLE.stranger]!);
const relayer = privateKeyToAccount(ANVIL_KEYS[ROLE.relayer]!);

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function cli(args: string[], env: Record<string, string> = {}): Promise<CliResult> {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], {
      cwd: REPO_ROOT,
      env: { ...process.env, ...env },
      timeout: 240_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return { code: typeof e.code === "number" ? e.code : -1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

interface ServiceHandle {
  url: string;
  child: ChildProcess;
  logs: string[];
  stop(): Promise<void>;
}

async function startServiceProcess(env: Record<string, string>): Promise<ServiceHandle> {
  const port = await freePort();
  const logs: string[] = [];
  const child = spawn(process.execPath, [SERVICE], {
    cwd: REPO_ROOT,
    env: { ...process.env, PORT: String(port), LOG_LEVEL: "info", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (d) => logs.push(String(d)));
  child.stderr?.on("data", (d) => logs.push(String(d)));
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`service exited ${child.exitCode}:\n${logs.join("")}`);
    try {
      const res = await fetch(`${url}/health`);
      if (res.ok) break;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) throw new Error(`service did not become healthy:\n${logs.join("")}`);
    await new Promise((r) => setTimeout(r, 250));
  }
  return {
    url,
    child,
    logs,
    async stop() {
      if (child.exitCode !== null) return;
      child.kill("SIGTERM");
      await new Promise<void>((r) => child.once("exit", () => r()));
    },
  };
}

async function waitFor<T>(what: string, fn: () => Promise<T | undefined>, timeoutMs = 120_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

let anvil: Anvil;
let serviceRpc: FlakyRpc;
let verifyRpc: FlakyRpc;
let client: PublicClient;
let registry: Address;
let tmp: string;
let service: ServiceHandle;
const files: ReceiptFile[] = [];
let secondBatch: ReceiptFile;

before(async () => {
  for (const path of [CLI, SERVICE]) {
    assert.ok(existsSync(path), `${path} is missing: run "npm run build" at the repo root first`);
  }
  anvil = await startAnvil();
  client = createPublicClient({ chain: chainFor(anvil.chainId, [anvil.url]), transport: http(anvil.url) }) as PublicClient;
  ({ registry } = await deployRegistry({
    rpcUrl: anvil.url,
    chainId: anvil.chainId,
    deployerKey: ANVIL_KEYS[ROLE.owner]!,
    owner: privateKeyToAccount(ANVIL_KEYS[ROLE.owner]!).address,
    serviceSigner: privateKeyToAccount(ANVIL_KEYS[ROLE.service]!).address,
  }));
  // The service's RPC drops answers after forwarding too ("was my tx sent?"); verify's does not need to.
  serviceRpc = await startFlakyRpc({ upstream: anvil.url, failureRate: 0.2, modes: [...DEFAULT_MODES, "drop-response"], stallMs: 1_500, seed: 7 });
  verifyRpc = await startFlakyRpc({ upstream: anvil.url, failureRate: 0.3, stallMs: 1_500, seed: 11 });
  tmp = await mkdtemp(join(tmpdir(), "receipts-dod-"));
  service = await startServiceProcess({
    CHAIN_ID: String(anvil.chainId),
    HEMI_RPC_URLS: serviceRpc.url,
    REGISTRY_ADDRESS: registry,
    SERVICE_PRIVATE_KEY: ANVIL_KEYS[ROLE.service]!,
    RELAYER_PRIVATE_KEY: ANVIL_KEYS[ROLE.relayer]!,
    DB_PATH: join(tmp, "receipts.sqlite"),
    DEV_FREE: "1",
    BATCH_MAX_WAIT_SECONDS: "3",
    POLL_INTERVAL_SECONDS: "1",
    HEMI_CONFIRMATIONS: "3",
  });
});

after(async () => {
  await service?.stop();
  await serviceRpc?.stop();
  await verifyRpc?.stop();
  await anvil?.stop();
  if (tmp) await rm(tmp, { recursive: true, force: true });
});

describe("Definition of done (local chain, flaky RPC)", () => {
  test("three manifests → three receipts in ONE BatchAttested tx", async () => {
    const out = join(tmp, "receipts");
    const res = await cli(
      ["attest", ...DEMOS, "--service", service.url, "--wait=hemi-included", "--timeout", "180", "--interval", "0.5", "--out", out, "--json"],
      { AGENT_PRIVATE_KEY: agentKey },
    );
    assert.equal(res.code, 0, `attest failed:\n${res.stdout}\n${res.stderr}\n${service.logs.join("")}`);
    const outcomes = JSON.parse(res.stdout) as { runId: Hex; receiptFile: string; status: string }[];
    assert.equal(outcomes.length, 3);
    for (const o of outcomes) files.push(JSON.parse(await readFile(o.receiptFile, "utf8")) as ReceiptFile);
    assert.equal(new Set(files.map((f) => f.receipt.runId)).size, 3, "three distinct receipt ids");

    const anchors = files.map((f) => f.anchor!);
    assert.ok(anchors.every(Boolean), "every receipt is anchored");
    assert.equal(new Set(anchors.map((a) => a.txHash)).size, 1, "one anchoring transaction");
    assert.equal(new Set(anchors.map((a) => a.batchId)).size, 1, "one batch");

    const tx = await client.getTransactionReceipt({ hash: anchors[0]!.txHash });
    const events = parseEventLogs({ abi: receiptRegistryAbi, logs: tx.logs, eventName: "BatchAttested" });
    assert.equal(events.length, 1, "exactly one BatchAttested in the tx");
    assert.equal(events[0]!.args.count, 3, "the batch covers all three receipts");
    assert.equal(events[0]!.args.root, anchors[0]!.root);
  });

  test("each receipt reaches hemi-confirmed (`receipts status`)", async () => {
    await mine(anvil.url, 40); // past anvil's safe head (latest − 32) and HEMI_CONFIRMATIONS
    for (const f of files) {
      const stage = await waitFor(`hemi-confirmed for ${f.receipt.runId}`, async () => {
        const res = await cli(["status", f.receipt.runId, "--service", service.url, "--json"]);
        if (res.code !== 0) return undefined;
        const status = JSON.parse(res.stdout) as { status?: { stage: string }; stage?: string };
        const s = status.status?.stage ?? status.stage;
        return s === "hemi-confirmed" || s?.startsWith("btc-") ? s : undefined;
      });
      assert.ok(["hemi-confirmed", "btc-published", "btc-final"].includes(stage));
    }
  });

  test("an identical resubmission returns the original receipt without a new tx", async () => {
    const before = { nonce: await client.getTransactionCount({ address: relayer.address }), batches: await batchCount() };
    const res = await cli(["attest", DEMOS[0]!, "--service", service.url, "--json"], { AGENT_PRIVATE_KEY: agentKey });
    assert.equal(res.code, 0, res.stderr);
    const [outcome] = JSON.parse(res.stdout) as { runId: Hex; created: boolean; httpStatus: number }[];
    assert.equal(outcome!.runId, files[0]!.receipt.runId);
    assert.equal(outcome!.created, false, "not a new receipt");
    assert.equal(outcome!.httpStatus, 200);
    await new Promise((r) => setTimeout(r, 5_000)); // longer than BATCH_MAX_WAIT_SECONDS
    assert.equal(await client.getTransactionCount({ address: relayer.address }), before.nonce, "no new transaction");
    assert.equal(await batchCount(), before.batches, "no new batch");
  });

  test("a different manifest with a reused runId is rejected", async () => {
    const original = JSON.parse(await readFile(DEMOS[0]!, "utf8"));
    const changed = join(tmp, "reused-run-id.json");
    await writeFile(changed, JSON.stringify({ ...original, model: `${original.model}-changed` }));
    const res = await cli(["attest", changed, "--service", service.url], { AGENT_PRIVATE_KEY: agentKey });
    assert.equal(res.code, 1);
    assert.match(res.stderr, /409|already used/i);
  });

  test("a second batch exists (for the wrong-batch case)", async () => {
    const manifestPath = join(tmp, "fourth.json");
    const made = await cli(["from-trace", resolve(REPO_ROOT, "examples/trace.jsonl"), "--agent", agent.address, "--run-id", newRunId(), "-o", manifestPath]);
    assert.equal(made.code, 0, made.stderr);
    const res = await cli(
      ["attest", manifestPath, "--service", service.url, "--wait=hemi-included", "--timeout", "180", "--interval", "0.5", "--out", join(tmp, "receipts"), "--json"],
      { AGENT_PRIVATE_KEY: agentKey },
    );
    assert.equal(res.code, 0, `${res.stdout}\n${res.stderr}`);
    const [outcome] = JSON.parse(res.stdout) as { receiptFile: string }[];
    secondBatch = JSON.parse(await readFile(outcome!.receiptFile, "utf8")) as ReceiptFile;
    assert.notEqual(secondBatch.anchor!.batchId, files[0]!.anchor!.batchId);
  });

  describe("verification with the service stopped (RPC + registry only)", () => {
    before(async () => {
      await service.stop();
      await assert.rejects(fetch(`${service.url}/health`), "the service is really down");
    });

    async function verifyFile(file: ReceiptFile, name: string): Promise<{ code: number; result: { valid: boolean; reasons: string[] } }> {
      const path = join(tmp, `${name}.receipt.json`);
      await writeFile(path, JSON.stringify(file, null, 2));
      const res = await cli(["verify", path, "--rpc", verifyRpc.url, "--registry", registry, "--json"]);
      assert.ok(res.code === 0 || res.code === 1, `verify could not run (exit ${res.code}):\n${res.stdout}\n${res.stderr}`);
      return { code: res.code, result: JSON.parse(res.stdout) };
    }

    test("a real receipt verifies: valid true", async () => {
      for (const [i, f] of files.entries()) {
        const { code, result } = await verifyFile(f, `real-${i}`);
        assert.equal(code, 0, result.reasons.join("; "));
        assert.equal(result.valid, true);
      }
    });

    test("(a) a manifest with one changed byte: valid false, with a reason", async () => {
      const f = structuredClone(files[0]!);
      const model = f.manifest!.model;
      f.manifest!.model = model.slice(0, -1) + String.fromCharCode(model.charCodeAt(model.length - 1) ^ 1);
      const { code, result } = await verifyFile(f, "one-byte");
      assert.equal(code, 1);
      assert.equal(result.valid, false);
      assert.match(result.reasons.join(" "), /manifest/i);
    });

    test("(b) a proof against the wrong batch: valid false, with a reason", async () => {
      const f = structuredClone(files[0]!);
      f.anchor = { ...secondBatch.anchor!, proof: files[0]!.anchor!.proof };
      const { code, result } = await verifyFile(f, "wrong-batch");
      assert.equal(code, 1);
      assert.equal(result.valid, false);
      assert.match(result.reasons.join(" "), /proof|batch|root/i);
    });

    test("(c) a forged agent signature: valid false, with a reason", async () => {
      const f = structuredClone(files[0]!);
      f.agentSignature = await signReceipt(stranger, f.receipt, registryDomain(f.chainId, registry));
      const { code, result } = await verifyFile(f, "forged-signature");
      assert.equal(code, 1);
      assert.equal(result.valid, false);
      assert.match(result.reasons.join(" "), /signature/i);
    });

    test("the flaky RPC really failed requests during the run", () => {
      const injected = (rpc: FlakyRpc) => Object.values(rpc.stats.injected).reduce((a, b) => a + (b ?? 0), 0);
      assert.ok(injected(serviceRpc) > 0, "the service's RPC proxy injected failures");
      assert.ok(injected(verifyRpc) > 0, "verify's RPC proxy injected failures");
    });
  });

  test("without DEV_FREE, POST /attest answers 402 with x402 payment requirements", async () => {
    const paid = await startServiceProcess({
      CHAIN_ID: String(anvil.chainId),
      HEMI_RPC_URLS: anvil.url,
      REGISTRY_ADDRESS: registry,
      SERVICE_PRIVATE_KEY: ANVIL_KEYS[ROLE.service]!,
      RELAYER_PRIVATE_KEY: ANVIL_KEYS[ROLE.relayer]!,
      DB_PATH: join(tmp, "paid.sqlite"),
      PAY_TO: stranger.address,
      PAYMENT_ASSET: "0x00000000000000000000000000000000000000aa",
      PAYMENT_ASSET_TRANSFER_METHOD: "permit2",
      FACILITATOR_URL: "http://127.0.0.1:9",
    });
    try {
      const manifest = normalizeManifest({ ...JSON.parse(await readFile(DEMOS[1]!, "utf8")), runId: newRunId() });
      const receipt = receiptFromManifest(manifest);
      const agentSignature = await signReceipt(agent, receipt, registryDomain(anvil.chainId, registry));
      const err = await submit(paid.url, { manifest, agentSignature }).then(
        () => undefined,
        (e: unknown) => e,
      );
      assert.ok(err instanceof PaymentRequiredError, `expected 402, got ${String(err)}\n${paid.logs.join("")}`);
      const accepts = err.accepts ?? err.paymentRequired?.accepts;
      assert.ok(Array.isArray(accepts) && accepts.length > 0, "payment requirements list what is accepted");
      const option = accepts[0]!;
      assert.equal(option.scheme, "exact");
      assert.equal(option.network, `eip155:${anvil.chainId}`);
      assert.equal(String(option.asset).toLowerCase(), "0x00000000000000000000000000000000000000aa");
      assert.equal(String(option.amount), "1000");
      assert.equal(String(option.payTo).toLowerCase(), stranger.address.toLowerCase());
    } finally {
      await paid.stop();
    }
  });
});

async function batchCount(): Promise<bigint> {
  return client.readContract({ address: registry, abi: receiptRegistryAbi, functionName: "batchCount" });
}
