/**
 * attest / status / fetch against an in-process fake service whose batches are really
 * anchored on anvil, so the receipt files the CLI writes can be verified end to end.
 */
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { createPublicClient, encodeFunctionData, http, type Address, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  ANVIL_KEYS,
  ROLE,
  anchorBatch,
  anchorDirect,
  deployRegistry,
  voidBatch,
  makeManifest,
  mine,
  startAnvil,
  startFakeService,
  type Anvil,
  type FakeService,
} from "@hemi-receipts/e2e/lib";
import { chainFor, newRunId, normalizeManifest, receiptFromManifest, receiptRegistryAbi, type ManifestV1, type ReceiptFields } from "@hemi-receipts/sdk";
import { cli, REPO, tempDir } from "./helpers.js";

const CHAIN_ID = 743_111;
const AGENT_KEY = ANVIL_KEYS[ROLE.agent]!;
const PRINCIPAL_KEY = ANVIL_KEYS[ROLE.principal]!;
let anvil: Anvil;
let client: PublicClient;
let registry: Address;
let service: FakeService;
const dir = tempDir();

function writeManifest(name: string, manifest: ManifestV1): string {
  const path = join(dir.path, name);
  writeFileSync(path, JSON.stringify(manifest, null, 2));
  return path;
}

async function waitFor(condition: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

before(async () => {
  anvil = await startAnvil({ chainId: CHAIN_ID });
  client = createPublicClient({ chain: chainFor(CHAIN_ID, [anvil.url]), transport: http(anvil.url) }) as PublicClient;
  ({ registry } = await deployRegistry({
    rpcUrl: anvil.url,
    chainId: CHAIN_ID,
    deployerKey: ANVIL_KEYS[ROLE.owner]!,
    owner: privateKeyToAccount(ANVIL_KEYS[ROLE.owner]!).address,
    serviceSigner: privateKeyToAccount(ANVIL_KEYS[ROLE.service]!).address,
  }));
  const common = { client, registry, serviceKey: ANVIL_KEYS[ROLE.service]! };
  service = await startFakeService({
    chainId: CHAIN_ID,
    registry,
    client,
    confirmations: 3,
    anchor: (items) => anchorBatch({ ...common, items }),
    anchorDirect: (item) => anchorDirect({ ...common, item }),
  });
});

after(async () => {
  await service?.stop();
  await anvil?.stop();
  dir.cleanup();
});

const env = (extra: Record<string, string> = {}) => ({ AGENT_PRIVATE_KEY: AGENT_KEY, RECEIPTS_SERVICE_URL: service.url, ...extra });

describe("attest", () => {
  test("submits the demo manifests and prints '<runId> <status>' per manifest", async () => {
    const files = ["examples/manifests/demo-1.json", "examples/manifests/demo-2.json", "examples/manifests/demo-3.json"];
    const r = await cli(["attest", ...files], { env: env() });
    assert.equal(r.code, 0, r.stderr);
    const lines = r.stdout.split("\n");
    assert.equal(lines.length, 3);
    for (const [i, file] of files.entries()) {
      const runId = JSON.parse(readFileSync(join(REPO, file), "utf8")).runId;
      assert.equal(lines[i], `${runId} pending`);
    }
    assert.ok(service.requests.some((q) => q.method === "GET" && q.path === "/health"), "domain read from /health");
    // identical resubmission is fine
    const again = await cli(["attest", files[0]!], { env: env() });
    assert.equal(again.code, 0);
    assert.match(again.stdout, /pending \(already submitted\)$/);
  });

  test("--wait anchors, writes <runId>.receipt.json with the manifest, and the file verifies", async () => {
    const m1 = makeManifest();
    const m2 = makeManifest();
    const out = join(dir.path, "receipts");
    const before = service.entries.size;
    const running = cli(["attest", writeManifest("w1.json", m1), writeManifest("w2.json", m2), "--wait", "--interval", "0.05", "--timeout", "20", "--out", out, "--store"], { env: env() });
    await waitFor(() => service.entries.size >= before + 2);
    await service.flush();
    const r = await running;
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.stdout.split("\n"), [`${m1.runId} hemi-included`, `${m2.runId} hemi-included`]);
    for (const m of [m1, m2]) {
      const path = join(out, `${m.runId}.receipt.json`);
      assert.ok(existsSync(path), path);
      const file = JSON.parse(readFileSync(path, "utf8"));
      assert.equal(file.status, undefined, "status is not part of a receipt file");
      assert.deepEqual(file.manifest, m);
      assert.equal(file.anchor.mode, "batch");
      const v = await cli(["verify", path, "--rpc", anvil.url, "--registry", registry]);
      assert.equal(v.code, 0, v.stdout);
      assert.match(v.stdout, /VALID: in batch \d+, anchored by tx 0x[0-9a-f]{64} \(https:\/\/testnet\.explorer\.hemi\.xyz\/tx\/0x/);
    }
  });

  test("--timeout is one deadline for every receipt, not one per receipt", async () => {
    // Nothing flushes these, so both stay pending. With a per-receipt timeout the command would take at least twice as long.
    const m1 = makeManifest();
    const m2 = makeManifest();
    const started = Date.now();
    const r = await cli(["attest", writeManifest("t1.json", m1), writeManifest("t2.json", m2), "--wait", "--interval", "0.05", "--timeout", "3", "--out", dir.path], { env: env() });
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 5_500, `took ${elapsed} ms for a 3 s timeout`);
    assert.equal(r.code, 1, r.stderr);
    const all = r.stdout + r.stderr;
    for (const m of [m1, m2]) assert.match(all, new RegExp(`the 3s --timeout, shared by every receipt, ran out before ${m.runId} reached hemi-included \\(still pending\\)`));
  });

  test("--timeout bounds a stalled status request and does not request later receipts after the deadline", { timeout: 5_000 }, async () => {
    const m1 = makeManifest();
    const m2 = makeManifest();
    const polled: string[] = [];
    let requestSignal: AbortSignal | undefined;
    const r = await cli([
      "attest", writeManifest("stalled1.json", m1), writeManifest("stalled2.json", m2),
      "--wait", "--timeout", "0.05", "--out", dir.path, "--json",
    ], {
      env: env(),
      fetch: (input, init) => {
        if (String(input).includes("/receipts/")) {
          polled.push(String(input));
          requestSignal = init?.signal ?? undefined;
          return new Promise<Response>(() => {});
        }
        return fetch(input, init);
      },
    });
    assert.equal(r.code, 1, r.stderr);
    assert.deepEqual(polled, [`${service.url}/receipts/${m1.runId}`]);
    assert.equal(requestSignal?.aborted, true);
    const outcomes = JSON.parse(r.stdout);
    assert.equal(outcomes.length, 2);
    for (const [i, m] of [m1, m2].entries()) {
      assert.equal(outcomes[i].runId, m.runId);
      assert.match(outcomes[i].error, /--timeout, shared by every receipt, ran out/);
      assert.equal(outcomes[i].status, "pending", "retain the last known submission status");
      assert.ok(!existsSync(join(dir.path, `${m.runId}.receipt.json`)), "no successful receipt file after timeout");
    }
  });

  test("--direct with --wait=hemi-included, --json, signed by the principal, explicit domain", async () => {
    const m = makeManifest();
    const health = service.requests.filter((q) => q.path === "/health").length;
    const r = await cli(
      ["attest", writeManifest("d.json", m), "--direct", "--wait=hemi-included", "--interval", "0.05", "--out", dir.path, "--json", "--key-env", "PRINCIPAL_KEY", "--chain-id", String(CHAIN_ID), "--registry", registry],
      { env: { RECEIPTS_SERVICE_URL: service.url, PRINCIPAL_KEY } },
    );
    assert.equal(r.code, 0, r.stderr);
    assert.equal(service.requests.filter((q) => q.path === "/health").length, health, "no /health call when the domain is given");
    const [outcome] = JSON.parse(r.stdout);
    assert.equal(outcome.runId, m.runId);
    assert.equal(outcome.status, "hemi-included");
    assert.equal(outcome.httpStatus, 202);
    const file = JSON.parse(readFileSync(outcome.receiptFile, "utf8"));
    assert.equal(file.anchor.mode, "direct");
    assert.ok(outcome.attestFile && existsSync(outcome.attestFile), "the countersigned calldata is written for the caller's own transaction");
    const attest = JSON.parse(readFileSync(outcome.attestFile, "utf8"));
    assert.equal(attest.to.toLowerCase(), registry.toLowerCase());
    assert.equal(attest.receipt.runId, m.runId);
    assert.match(attest.data, /^0x[0-9a-f]{8,}$/);
    assert.equal(attest.receiptUrl, `${service.url}/receipts/${m.runId}`);
    const v = await cli(["verify", outcome.receiptFile, "--rpc", anvil.url, "--registry", registry, "--json"]);
    assert.equal(v.code, 0);
    assert.equal(JSON.parse(v.stdout).signer.role, "principal");
  });

  test("a key that is neither agent nor principal, an invalid manifest, and a reused runId fail with exit 1", async () => {
    const good = makeManifest();
    const stranger = await cli(["attest", writeManifest("s.json", good)], { env: env({ AGENT_PRIVATE_KEY: ANVIL_KEYS[ROLE.stranger]! }) });
    assert.equal(stranger.code, 1);
    assert.match(stranger.stderr, /AGENT_PRIVATE_KEY is 0x[0-9a-fA-F]{40}, which is neither the agent 0x90f79bf6eb2c4f870365e785982e1f101e93b906 nor the principal/);

    const invalid = writeManifest("bad.json", { ...good, model: "" });
    const bad = await cli(["attest", invalid, writeManifest("ok.json", good)], { env: env() });
    assert.equal(bad.code, 1, "one bad manifest fails the run");
    assert.match(bad.stderr, /bad\.json: invalid manifest: model: must not be empty/);
    assert.equal(bad.stdout, `${good.runId} pending`, "the good one is still submitted");

    const reused = writeManifest("reused.json", { ...good, model: "something else" });
    const conflict = await cli(["attest", reused], { env: env() });
    assert.equal(conflict.code, 1);
    assert.match(conflict.stderr, new RegExp(`runId ${good.runId}: this run id is already registered for a different receipt .*\\(409\\)`));
  });

  test("a 409 for a payment still settling says to wait: a new runId would pay twice", async () => {
    const stub = createServer((req, res) => {
      req.resume();
      res.setHeader("content-type", "application/json");
      if (req.method === "GET") return void res.end(JSON.stringify({ ok: true, chainId: CHAIN_ID, registry }));
      res.statusCode = 409;
      res.end(JSON.stringify({ error: "payment_pending", message: "an earlier payment for this receipt may still be settling; retry later instead of paying again" }));
    });
    await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
    try {
      const url = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
      const held = await cli(["attest", writeManifest("held.json", makeManifest())], { env: env({ RECEIPTS_SERVICE_URL: url }) });
      assert.equal(held.code, 1);
      assert.match(held.stderr, /retry later instead of paying again \(409\)/);
      assert.doesNotMatch(held.stderr, /different manifest|new runId/);
    } finally {
      stub.close();
    }
  });

  test("--direct refuses an answer for another run, another receipt, another contract or another call; nothing is written", async () => {
    const other = "0x00000000000000000000000000000000000000aa" as Address;
    let answer: (sent: { manifest: ManifestV1; agentSignature: Hex }) => unknown = () => ({});
    const stub = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        res.setHeader("content-type", "application/json");
        if (req.method === "GET") return void res.end(JSON.stringify({ ok: true, chainId: CHAIN_ID, registry }));
        res.statusCode = 202;
        res.end(JSON.stringify(answer(JSON.parse(Buffer.concat(chunks).toString("utf8")))));
      });
    });
    await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
    const out = tempDir();
    try {
      const url = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
      const direct = (sent: { manifest: ManifestV1; agentSignature: Hex }, over: { receipt?: ReceiptFields; to?: Address; data?: Hex } = {}) => {
        const receipt = over.receipt ?? receiptFromManifest(normalizeManifest(sent.manifest));
        const deadline = Math.floor(Date.now() / 1000) + 600;
        const data = over.data ?? encodeFunctionData({ abi: receiptRegistryAbi, functionName: "attest", args: [receipt, sent.agentSignature, BigInt(deadline), "0x1234"] });
        return { receipt, agentSignature: sent.agentSignature, deadline, serviceSignature: "0x1234", registry, chainId: CHAIN_ID, to: over.to ?? registry, data };
      };
      const run = async (name: string) => cli(["attest", writeManifest(`${name}.json`, makeManifest()), "--direct", "--out", out.path], { env: env({ RECEIPTS_SERVICE_URL: url }) });
      const cases: [string, typeof answer, RegExp][] = [
        ["traversal", (s) => ({ ...direct(s), receipt: { ...direct(s).receipt, runId: "../../escaped" } }), /unexpected response/],
        ["other-run", (s) => direct(s, { receipt: { ...receiptFromManifest(normalizeManifest(s.manifest)), runId: newRunId() } }), /is for run 0x[0-9a-f]{64}, not 0x[0-9a-f]{64}; refusing it, nothing was written/],
        ["other-contract", (s) => direct(s, { to: other }), new RegExp(`sends to ${other}, not the registry`, "i")],
        ["other-call", (s) => direct(s, { data: encodeFunctionData({ abi: receiptRegistryAbi, functionName: "getBatch", args: [1n] }) }), /calls getBatch, not attest/],
      ];
      for (const [name, reply, expected] of cases) {
        answer = reply;
        const r = await run(name);
        assert.equal(r.code, 1, `${name}: ${r.stderr}`);
        assert.match(r.stderr, expected, name);
      }
      assert.deepEqual(readdirSync(out.path), [], "no attest file written for any of them");
      assert.ok(!existsSync(join(out.path, "..", "..", "escaped.attest.json")), "nothing written outside --out");
      answer = (s) => direct(s);
      const ok = await run("ok");
      assert.equal(ok.code, 0, ok.stderr);
      assert.equal(readdirSync(out.path).length, 1, "a matching answer is written");
    } finally {
      stub.close();
      out.cleanup();
    }
  });

  test("usage errors exit 2: no key, bad --wait stage, unreachable service", async () => {
    const path = writeManifest("u.json", makeManifest());
    const noKey = await cli(["attest", path], { env: { RECEIPTS_SERVICE_URL: service.url } });
    assert.equal(noKey.code, 2);
    assert.match(noKey.stderr, /AGENT_PRIVATE_KEY .* must be a 0x-prefixed 32-byte hex private key/);
    const badStage = await cli(["attest", path, "--wait=done"], { env: env() });
    assert.equal(badStage.code, 2);
    const down = await cli(["attest", path, "--service", "http://127.0.0.1:1"], { env: env() });
    assert.equal(down.code, 2);
    assert.match(down.stderr, /cannot read the EIP-712 domain from http:\/\/127\.0\.0\.1:1\/health/);
  });
});

describe("status and fetch", () => {
  let manifest: ManifestV1;
  before(async () => {
    manifest = makeManifest();
    const r = await cli(["attest", writeManifest("sf.json", manifest)], { env: env() });
    assert.equal(r.code, 0, r.stderr);
  });

  test("status of a pending receipt", async () => {
    const r = await cli(["status", manifest.runId, "--service", service.url]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^runId\s+0x[0-9a-f]{64}$/m);
    assert.match(r.stdout, /^stage\s+pending$/m);
    assert.match(r.stdout, /^anchor\s+not anchored yet/m);
  });

  test("status after anchoring: the service's view (--no-btc), then the local check (safe head, Bitcoin)", async () => {
    await service.flush();
    const included = await cli(["status", manifest.runId, "--no-btc"], { env: { RECEIPTS_SERVICE_URL: service.url } });
    assert.equal(included.code, 0, included.stderr);
    assert.match(included.stdout, /^stage\s+hemi-included$/m);
    assert.match(included.stdout, /^source\s+receipts service$/m);
    assert.match(included.stdout, /^hemi\s+block \d+ on Hemi Testnet, 1 confirmation \(3 required\), safe head \d+, head \d+$/m);
    assert.match(included.stdout, /^explorer\s+https:\/\/testnet\.explorer\.hemi\.xyz\/tx\/0x[0-9a-f]{64}$/m);
    // chain id 743111: hemi-confirmed needs the safe head too (anvil: latest − 32)
    await mine(anvil.url, 35);
    const confirmed = await cli(["status", manifest.runId, "--service", service.url, "--rpc", anvil.url, "--registry", registry, "--json"]);
    assert.equal(confirmed.code, 0, confirmed.stderr);
    const s = JSON.parse(confirmed.stdout);
    assert.equal(s.source, "local");
    assert.equal(s.serviceStage, "hemi-confirmed");
    assert.equal(s.stage, "hemi-confirmed");
    assert.equal(s.estimated, false);
    assert.ok(s.hemi.confirmations >= 3);
    assert.ok(s.hemi.safeBlock >= s.hemi.blockNumber);
    assert.equal(s.btc.source, "unavailable");
    assert.match(s.btc.detail, /^no PoP activity: no PoP payout in \d+ keystone blocks? sampled over the last /);
    assert.match(s.explorer, /^https:\/\/testnet\.explorer\.hemi\.xyz\/tx\//);
    const text = await cli(["status", manifest.runId, "--service", service.url, "--rpc", anvil.url, "--registry", registry]);
    assert.match(text.stdout, /^source\s+checked locally \(Hemi RPC \+ Bitcoin\); the service says hemi-confirmed$/m);
    assert.match(text.stdout, /^bitcoin\s+unavailable: no PoP activity: no PoP payout in \d+ keystone blocks? sampled over the last /m);
    const service_ = await cli(["status", manifest.runId, "--service", service.url, "--no-btc"]);
    assert.match(service_.stdout, /^bitcoin\s+unavailable: no Bitcoin finality source configured$/m);
  });

  test("status flags are validated; an unreachable RPC falls back to the service's status", async () => {
    assert.equal((await cli(["status", manifest.runId, "--service", service.url, "--btc-scan", "-1"])).code, 2);
    assert.equal((await cli(["status", manifest.runId, "--service", service.url, "--pop-miner", "0x1234"])).code, 2);
    assert.equal((await cli(["status", manifest.runId, "--service", service.url, "--esplora", "ftp://x"])).code, 2);
    const down = await cli(["status", manifest.runId, "--service", service.url, "--rpc", "http://127.0.0.1:1"]);
    assert.equal(down.code, 0);
    assert.match(down.stderr, /warning: could not check the stage locally/);
    assert.match(down.stdout, /^source\s+receipts service$/m);
  });

  test("status reads the anchor from the chain: an anchor the chain lacks is pending, a voided batch is voided", async () => {
    const m = makeManifest();
    assert.equal((await cli(["attest", writeManifest("void.json", m)], { env: env() })).code, 0);
    await service.flush();
    await mine(anvil.url, 35);
    const check = async (url: string) => {
      const r = await cli(["status", m.runId, "--service", url, "--rpc", anvil.url, "--registry", registry, "--json"]);
      assert.equal(r.code, 0, r.stderr);
      return JSON.parse(r.stdout);
    };
    const before = await check(service.url);
    assert.equal(before.stage, "hemi-confirmed");
    assert.equal(before.source, "local");

    // A service that reports another anchoring transaction: the chain's own log decides.
    const fakeTx = `0x${"ab".repeat(32)}`;
    let lie: (anchor: { txHash: string; batchId: number }) => void = (a) => void (a.txHash = fakeTx);
    const liar = createServer(async (req, res) => {
      const upstream = await fetch(`${service.url}${req.url}`);
      const body = (await upstream.json()) as { anchor?: { txHash: string; batchId: number } } | null;
      if (body?.anchor) lie(body.anchor);
      res.writeHead(upstream.status, { "content-type": "application/json" }).end(JSON.stringify(body));
    });
    await new Promise<void>((resolve) => liar.listen(0, "127.0.0.1", resolve));
    try {
      const lied = await check(`http://127.0.0.1:${(liar.address() as AddressInfo).port}`);
      assert.equal(lied.serviceStage, "hemi-confirmed");
      assert.equal(lied.stage, "pending");
      assert.match(lied.notes.join("\n"), new RegExp(`was anchored by tx 0x[0-9a-f]{64}, not the anchor's ${fakeTx}`));
      lie = (a) => void (a.batchId = 9_999);
      const missing = await check(`http://127.0.0.1:${(liar.address() as AddressInfo).port}`);
      assert.equal(missing.stage, "pending");
      assert.match(missing.notes.join("\n"), /has no batch 9999 \(UnknownBatch\)/);
    } finally {
      liar.close();
    }

    // The owner voids the batch; this service never notices, the local check does.
    await voidBatch({ client, registry, batchId: before.anchor.batchId, root: before.anchor.root });
    const after = await check(service.url);
    assert.equal(after.serviceStage, "hemi-confirmed");
    assert.equal(after.stage, "voided");
    assert.match(after.notes.join("\n"), new RegExp(`the registry owner voided batch ${before.anchor.batchId}`));
  });

  test("fetch saves the receipt file, merges a matching manifest, and the file verifies", async () => {
    const out = join(dir.path, "fetched.json");
    const r = await cli(["fetch", manifest.runId, "--service", service.url, "-o", out, "--manifest", join(dir.path, "sf.json")]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stderr, /with manifest/);
    const file = JSON.parse(readFileSync(out, "utf8"));
    assert.deepEqual(file.manifest, manifest);
    assert.equal(file.status, undefined);
    const v = await cli(["verify", out, "--rpc", anvil.url, "--registry", registry]);
    assert.equal(v.code, 0, v.stdout);
    assert.match(v.stdout, /pass  manifest/);
  });

  test("fetch refuses a manifest that does not match; -o - prints; default file name", async () => {
    const wrong = writeManifest("wrong.json", { ...manifest, model: "other" });
    const r = await cli(["fetch", manifest.runId, "--service", service.url, "--manifest", wrong, "-o", join(dir.path, "x.json")]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /wrong\.json hashes to 0x[0-9a-f]{64}, but receipt 0x[0-9a-f]{64} has manifestHash 0x[0-9a-f]{64}; not merging/);
    const printed = await cli(["fetch", manifest.runId, "--service", service.url, "-o", "-"]);
    assert.equal(JSON.parse(printed.stdout).receipt.runId, manifest.runId);
    const named = await cli(["fetch", manifest.runId, "--service", service.url], { cwd: dir.path });
    assert.equal(named.code, 0);
    assert.ok(existsSync(join(dir.path, `${manifest.runId}.receipt.json`)));
  });

  test("unknown runId exits 1; a malformed runId or unreachable service exits 2", async () => {
    const unknown = await cli(["status", newRunId(), "--service", service.url]);
    assert.equal(unknown.code, 1);
    assert.match(unknown.stderr, /answered 404/);
    assert.equal((await cli(["fetch", newRunId(), "--service", service.url])).code, 1);
    assert.equal((await cli(["status", "0x1234", "--service", service.url])).code, 2);
    assert.equal((await cli(["status", newRunId(), "--service", "http://127.0.0.1:1"])).code, 2);
  });
});

describe("x402 payment", () => {
  const PAY_TO = "0x9965507d1a55bcc2695c58ba16fb37d819b0a4dc";
  const USDC_MAINNET = "0xad11a8BEb98bbf61dbb1aa0F6d6F2ECD87b35afA";
  const accepts = [
    {
      scheme: "exact",
      network: "eip155:43111",
      asset: USDC_MAINNET,
      amount: "1000",
      payTo: PAY_TO,
      maxTimeoutSeconds: 120,
      // mainnet USDC.e: EIP-3009, signed off-chain, no RPC needed to build the payment
      extra: { assetTransferMethod: "eip3009", name: "Bridged USDC (Stargate)", version: "2" },
    },
  ];
  let paid: FakeService;
  before(async () => {
    paid = await startFakeService({ chainId: CHAIN_ID, registry, payment: { accepts } });
  });
  after(async () => {
    await paid?.stop();
  });

  test("without X402_PRIVATE_KEY: exit 1 with the price", async () => {
    const r = await cli(["attest", writeManifest("p1.json", makeManifest()), writeManifest("p2.json", makeManifest())], { env: env({ RECEIPTS_SERVICE_URL: paid.url }) });
    assert.equal(r.code, 1);
    assert.match(r.stderr, new RegExp(`payment required: 1000 base units of ${USDC_MAINNET} on eip155:43111 to ${PAY_TO} \\(exact, eip3009\\)\\. Set X402_PRIVATE_KEY to pay with x402\\.`));
    assert.equal(r.stderr.match(/payment required/g)?.length, 1, "stops after the first 402");
  });

  test("with X402_PRIVATE_KEY: pays with @x402/fetch and retries", async () => {
    const payer = privateKeyToAccount(ANVIL_KEYS[ROLE.stranger]!);
    const m1 = makeManifest();
    const m2 = makeManifest();
    const r = await cli(["attest", writeManifest("p3.json", m1), writeManifest("p4.json", m2)], {
      env: env({ RECEIPTS_SERVICE_URL: paid.url, X402_PRIVATE_KEY: ANVIL_KEYS[ROLE.stranger]! }),
    });
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.stdout.split("\n"), [`${m1.runId} pending`, `${m2.runId} pending`]);
    assert.match(r.stderr, new RegExp(`paying 1000 base units of ${USDC_MAINNET} on eip155:43111 to ${PAY_TO} from ${payer.address}`));
    assert.equal(paid.payments.length, 2);
    const payment = paid.payments[0] as { x402Version: number; accepted: { payTo: string }; payload: { authorization: { from: string; to: string; value: string }; signature: Hex } };
    assert.equal(payment.x402Version, 2);
    assert.equal(payment.payload.authorization.from.toLowerCase(), payer.address.toLowerCase());
    assert.equal(payment.payload.authorization.to.toLowerCase(), PAY_TO);
    assert.equal(payment.payload.authorization.value, "1000");
    assert.match(payment.payload.signature, /^0x[0-9a-f]{130}$/);
  });

  test("a price above X402_MAX_AMOUNT is refused", async () => {
    const before = paid.payments.length;
    const r = await cli(["attest", writeManifest("p5.json", makeManifest())], {
      env: env({ RECEIPTS_SERVICE_URL: paid.url, X402_PRIVATE_KEY: ANVIL_KEYS[ROLE.stranger]!, X402_MAX_AMOUNT: "999" }),
    });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /more than the per-payment cap of 999 base units; raise it with X402_MAX_AMOUNT/);
    assert.equal(paid.payments.length, before);
  });

  test("a connection cut while paying says the payment may have gone through, and to retry the same runId", async () => {
    const manifest = makeManifest();
    paid.dropPaid = true;
    try {
      const r = await cli(["attest", writeManifest("p6.json", manifest)], {
        env: env({ RECEIPTS_SERVICE_URL: paid.url, X402_PRIVATE_KEY: ANVIL_KEYS[ROLE.stranger]! }),
      });
      assert.equal(r.code, 1);
      assert.match(r.stderr, /the connection to the service broke while it was taking the payment \(.+\)\. The payment may have gone through/);
      assert.ok(r.stderr.includes(`retry runId ${manifest.runId} with the same manifest, because a new runId would pay again`), r.stderr);
    } finally {
      paid.dropPaid = false;
    }
  });
});
