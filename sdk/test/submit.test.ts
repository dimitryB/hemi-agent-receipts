import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Address, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ANVIL_KEYS, ROLE, makeManifest, signManifest, startFakeService, type FakeService } from "@hemi-receipts/e2e/lib";
import {
  ConflictError,
  decodePaymentRequired,
  getReceipt,
  getServiceInfo,
  NotFoundError,
  PaymentRequiredError,
  ServiceError,
  submit,
  submitDirect,
  ValidationError,
  waitForReceipt,
  WaitError,
  type FetchLike,
} from "../src/index.js";

const CHAIN_ID = 743_111;
const REGISTRY: Address = "0x5fbdb2315678afecb367f032d93f642f64180aa3";
let service: FakeService;

before(async () => {
  service = await startFakeService({ chainId: CHAIN_ID, registry: REGISTRY });
});
after(async () => {
  await service?.stop();
});

async function signed(overrides = {}) {
  return signManifest({ manifest: makeManifest(overrides), chainId: CHAIN_ID, registry: REGISTRY });
}

describe("submit", () => {
  test("202 for a new receipt, 200 for an identical resubmission", async () => {
    const s = await signed();
    const first = await submit(service.url, { manifest: s.manifest, agentSignature: s.agentSignature, store: true });
    assert.equal(first.httpStatus, 202);
    assert.equal(first.created, true);
    assert.equal(first.runId, s.manifest.runId);
    assert.equal(first.stage, "pending");
    assert.equal(first.receiptUrl, `${service.url}/receipts/${s.manifest.runId}`);
    const body = service.requests.at(-1)!.body as Record<string, unknown>;
    assert.deepEqual(Object.keys(body).sort(), ["agentSignature", "manifest", "store"]);

    const again = await submit(service.url, { manifest: s.manifest, agentSignature: s.agentSignature });
    assert.equal(again.httpStatus, 200);
    assert.equal(again.created, false);
    assert.equal(again.receipt?.receipt.manifestHash, s.receipt.manifestHash);
    assert.equal(again.receipt?.manifest?.runId, s.manifest.runId, "stored manifest returned");
    assert.equal(again.stage, "pending");
  });

  test("a receipt alone (manifest kept private) is accepted", async () => {
    const s = await signed();
    const result = await submit(`${service.url}/`, { receipt: s.receipt, agentSignature: s.agentSignature });
    assert.equal(result.httpStatus, 202);
    assert.equal(service.requests.at(-1)!.path, "/attest", "trailing slash in the service URL is fine");
    assert.equal((service.requests.at(-1)!.body as Record<string, unknown>).manifest, undefined);
  });

  test("409 ConflictError when the runId is reused with a different manifest", async () => {
    const s = await signed();
    await submit(service.url, { manifest: s.manifest, agentSignature: s.agentSignature });
    const other = await signed({ runId: s.manifest.runId, model: "another-model" });
    await assert.rejects(submit(service.url, { manifest: other.manifest, agentSignature: other.agentSignature }), (e: unknown) => {
      assert.ok(e instanceof ConflictError);
      assert.equal(e.status, 409);
      assert.equal(e.runId, s.manifest.runId);
      assert.equal(e.code, "run_id_conflict");
      assert.match(e.reason ?? "", /already registered for a different receipt/);
      assert.match(e.message, /answered 409: this run id is already registered/);
      return true;
    });
  });

  test("400 ValidationError carries the service's errors", async () => {
    const s = await signed();
    const bad = { ...s.manifest, model: "" };
    await assert.rejects(submit(service.url, { manifest: bad as never, agentSignature: s.agentSignature }), (e: unknown) => {
      assert.ok(e instanceof ValidationError && e instanceof ServiceError);
      assert.equal(e.status, 400);
      assert.ok(e.errors.some((m) => /model: must not be empty/.test(m)), e.errors.join());
      return true;
    });
    const stranger = privateKeyToAccount(ANVIL_KEYS[ROLE.stranger]!);
    const forged = await signManifest({ manifest: s.manifest, chainId: CHAIN_ID, registry: REGISTRY, signerKey: ANVIL_KEYS[ROLE.stranger]! });
    await assert.rejects(submit(service.url, { manifest: s.manifest, agentSignature: forged.agentSignature }), (e: unknown) => {
      assert.ok(e instanceof ValidationError);
      assert.match(e.message, new RegExp(`recovers to ${stranger.address.toLowerCase()}`));
      return true;
    });
  });

  test("submitDirect posts to /attest/direct and returns the countersigned calldata; a resubmission replays it", async () => {
    const s = await signed();
    const result = await submitDirect(service.url, { manifest: s.manifest, agentSignature: s.agentSignature });
    assert.equal(service.requests.at(-1)!.path, "/attest/direct");
    assert.equal(result.httpStatus, 202);
    assert.equal(result.created, true);
    assert.equal(result.runId, s.manifest.runId);
    assert.equal(result.stage, "pending");
    assert.equal(result.receiptUrl, `${service.url}/receipts/${s.manifest.runId}`);
    assert.ok(result.direct, "the direct answer is the attestation to send, not a receipt file");
    assert.equal(result.direct.to, REGISTRY);
    assert.deepEqual(result.direct.receipt, s.receipt);
    assert.match(result.direct.data, /^0x[0-9a-f]{8,}$/);
    assert.match(result.direct.serviceSignature, /^0x[0-9a-f]{130}$/);
    assert.ok(result.direct.deadline > Date.now() / 1000);

    const again = await submitDirect(service.url, { manifest: s.manifest, agentSignature: s.agentSignature });
    assert.equal(again.httpStatus, 200);
    assert.equal(again.created, false);
    assert.equal(again.direct?.serviceSignature, result.direct.serviceSignature);
    assert.equal(again.stage, "pending");
  });

  test("input errors are thrown before any request", async () => {
    await assert.rejects(submit(service.url, { agentSignature: "0x00" }), /give a manifest or a receipt/);
  });

  test("an unreachable service is a ServiceError with status 0", async () => {
    await assert.rejects(getReceipt("http://127.0.0.1:1", `0x${"1".repeat(64)}`), (e: unknown) => e instanceof ServiceError && e.status === 0 && /cannot reach/.test(e.message));
  });

  test("a custom fetch is used for every call", async () => {
    let calls = 0;
    const counting: FetchLike = (input, init) => {
      calls++;
      return fetch(input, init);
    };
    const s = await signed();
    await submit(service.url, { manifest: s.manifest, agentSignature: s.agentSignature }, { fetch: counting });
    await getReceipt(service.url, s.manifest.runId, { fetch: counting });
    await getServiceInfo(service.url, { fetch: counting });
    assert.equal(calls, 3);
  });
});

describe("402 payment required", () => {
  const accepts = [
    {
      scheme: "exact",
      network: "eip155:743111",
      asset: "0xD47971C7F5B1067d25cd45d30b2c9eb60de96443",
      amount: "1000",
      payTo: "0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc",
      maxTimeoutSeconds: 60,
      extra: { assetTransferMethod: "permit2", name: "USDC.e", version: "2" },
    },
  ];
  let paid: FakeService;
  before(async () => {
    paid = await startFakeService({ chainId: CHAIN_ID, registry: REGISTRY, payment: { accepts } });
  });
  after(async () => {
    await paid?.stop();
  });

  test("PaymentRequiredError carries the decoded x402 requirements", async () => {
    const s = await signed();
    await assert.rejects(submit(paid.url, { manifest: s.manifest, agentSignature: s.agentSignature }), (e: unknown) => {
      assert.ok(e instanceof PaymentRequiredError);
      assert.equal(e.status, 402);
      assert.equal(e.paymentRequired?.x402Version, 2);
      assert.deepEqual(e.accepts, accepts);
      assert.match(e.message, /payment required: 1000 base units of 0xD47971C7F5B1067d25cd45d30b2c9eb60de96443 on eip155:743111/);
      return true;
    });
  });

  test("a paying fetch is retried with the payment header and succeeds", async () => {
    const s = await signed();
    // A minimal stand-in for @x402/fetch's wrapFetchWithPayment.
    const paying: FetchLike = async (input, init) => {
      const first = await fetch(input, init);
      if (first.status !== 402) return first;
      const req = decodePaymentRequired(first.headers, undefined)!;
      const headers = new Headers(init?.headers);
      headers.set("PAYMENT-SIGNATURE", Buffer.from(JSON.stringify({ x402Version: 2, accepted: req.accepts[0], payload: {} })).toString("base64"));
      return fetch(input, { ...init, headers });
    };
    const result = await submit(paid.url, { manifest: s.manifest, agentSignature: s.agentSignature }, { fetch: paying });
    assert.equal(result.httpStatus, 202);
    assert.equal(paid.payments.length, 1);
  });

  test("x402 v1 requirements in the body are decoded too", () => {
    const body = { x402Version: 1, error: "pay", accepts: [{ scheme: "exact", network: "hemi", asset: "0x1", maxAmountRequired: "5", payTo: "0x2" }] };
    assert.deepEqual(decodePaymentRequired(new Headers(), body)?.accepts, body.accepts);
    assert.equal(decodePaymentRequired(new Headers(), { nothing: true }), null);
  });
});

describe("getReceipt and waitForReceipt", () => {
  test("getReceipt returns the receipt file and status; 404 is NotFoundError", async () => {
    const s = await signed();
    await submit(service.url, { manifest: s.manifest, agentSignature: s.agentSignature, store: true });
    const r = await getReceipt(service.url, s.manifest.runId.toUpperCase().replace("0X", "0x"));
    assert.equal(r.format, "hemi-agent-receipt");
    assert.equal(r.status.stage, "pending");
    assert.equal(r.anchor, null);
    assert.deepEqual(r.manifest, s.manifest);
    await assert.rejects(getReceipt(service.url, `0x${"9".repeat(64)}`), NotFoundError);
  });

  test("getServiceInfo reads chainId and registry from /health", async () => {
    assert.deepEqual(await getServiceInfo(service.url).then((h) => [h.chainId, h.registry]), [CHAIN_ID, REGISTRY]);
  });

  test("waitForReceipt polls until the stage is reached", async () => {
    const s = await signed();
    await submit(service.url, { manifest: s.manifest, agentSignature: s.agentSignature });
    const seen: string[] = [];
    setTimeout(() => service.setStage(s.manifest.runId, "hemi-included"), 150);
    setTimeout(() => service.setStage(s.manifest.runId, "hemi-confirmed"), 300);
    const r = await waitForReceipt(service.url, s.manifest.runId, { until: "hemi-confirmed", intervalMs: 40, timeoutMs: 5_000, onStatus: (x) => seen.push(x.status.stage) });
    assert.equal(r.status.stage, "hemi-confirmed");
    assert.ok(seen.includes("pending") && seen.includes("hemi-included"), seen.join());
    // a later stage satisfies an earlier target
    service.setStage(s.manifest.runId, "btc-final");
    assert.equal((await waitForReceipt(service.url, s.manifest.runId, { until: "hemi-included", intervalMs: 10 })).status.stage, "btc-final");
  });

  test("waitForReceipt: timeout and voided are WaitErrors; 404 fails at once", async () => {
    const s = await signed();
    await submit(service.url, { manifest: s.manifest, agentSignature: s.agentSignature });
    await assert.rejects(waitForReceipt(service.url, s.manifest.runId, { until: "btc-final", intervalMs: 20, timeoutMs: 120 }), (e: unknown) => {
      assert.ok(e instanceof WaitError);
      assert.equal(e.reason, "timeout");
      assert.match(e.message, /still pending/);
      return true;
    });
    service.setStage(s.manifest.runId, "voided");
    await assert.rejects(waitForReceipt(service.url, s.manifest.runId, { intervalMs: 20 }), (e: unknown) => e instanceof WaitError && e.reason === "voided");
    const started = Date.now();
    await assert.rejects(waitForReceipt(service.url, `0x${"8".repeat(64)}`, { intervalMs: 20, timeoutMs: 5_000 }), NotFoundError);
    assert.ok(Date.now() - started < 1_000);
    await assert.rejects(waitForReceipt(service.url, s.manifest.runId, { until: "voided" as never }), /unknown stage/);
  });

  test("waitForReceipt rides through 5xx answers", async () => {
    const s = await signed();
    await submit(service.url, { manifest: s.manifest, agentSignature: s.agentSignature });
    service.setStage(s.manifest.runId, "hemi-included");
    let n = 0;
    const proxy = createServer(async (req, res) => {
      if (n++ < 3) return void res.writeHead(503).end("busy");
      const upstream = await fetch(`${service.url}${req.url}`);
      res.writeHead(upstream.status, { "content-type": "application/json" }).end(await upstream.text());
    });
    await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
    try {
      const url = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
      const r = await waitForReceipt(url, s.manifest.runId as Hex, { intervalMs: 10, timeoutMs: 5_000 });
      assert.equal(r.status.stage, "hemi-included");
      assert.equal(n, 4);
    } finally {
      proxy.closeAllConnections();
      await new Promise<void>((r) => proxy.close(() => r()));
    }
  });

  test("waitForReceipt times out a stuck fetch and ignores a late success", { timeout: 2_000 }, async () => {
    let finish!: (response: Response) => void;
    let requestSignal: AbortSignal | undefined;
    let calls = 0;
    const seen: string[] = [];
    const stalled: FetchLike = (_input, init) => {
      calls++;
      requestSignal = init?.signal ?? undefined;
      return new Promise<Response>((resolve) => { finish = resolve; });
    };
    await assert.rejects(waitForReceipt(service.url, `0x${"1".repeat(64)}`, {
      fetch: stalled, timeoutMs: 25, intervalMs: 1, onStatus: (r) => seen.push(r.status.stage),
    }), (e: unknown) => e instanceof WaitError && e.reason === "timeout");
    assert.equal(calls, 1);
    assert.equal(requestSignal?.aborted, true, "the timeout is also forwarded to fetch");
    finish(new Response(JSON.stringify({ format: "hemi-agent-receipt", status: { stage: "hemi-included" } })));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(seen, [], "a late response must not deliver status after the wait ended");
  });

  test("waitForReceipt's deadline includes reading the response body", { timeout: 2_000 }, async () => {
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(controller) { stream = controller; } });
    let requestSignal: AbortSignal | undefined;
    try {
      await assert.rejects(waitForReceipt(service.url, `0x${"1".repeat(64)}`, {
        timeoutMs: 25,
        fetch: async (_input, init) => {
          requestSignal = init?.signal ?? undefined;
          return new Response(body, { headers: { "content-type": "application/json" } });
        },
      }), (e: unknown) => e instanceof WaitError && e.reason === "timeout");
      assert.equal(requestSignal?.aborted, true);
    } finally {
      stream.close();
    }
  });

  test("waitForReceipt rejects an overdue success even before its timeout timer can run", async (t) => {
    let now = Date.now();
    t.mock.method(Date, "now", () => now);
    let delivered = false;
    await assert.rejects(waitForReceipt(service.url, `0x${"1".repeat(64)}`, {
      timeoutMs: 100,
      fetch: async () => {
        now += 101;
        return new Response(JSON.stringify({ format: "hemi-agent-receipt", status: { stage: "hemi-included" } }));
      },
      onStatus: () => { delivered = true; },
    }), (e: unknown) => e instanceof WaitError && e.reason === "timeout");
    assert.equal(delivered, false);
  });

  test("waitForReceipt does not start a request with an exhausted budget or an already-aborted signal", async () => {
    let calls = 0;
    const fetch: FetchLike = async () => { calls++; throw new Error("must not request"); };
    await assert.rejects(waitForReceipt(service.url, `0x${"1".repeat(64)}`, { fetch, timeoutMs: 0 }),
      (e: unknown) => e instanceof WaitError && e.reason === "timeout");
    const reason = new Error("caller cancelled");
    await assert.rejects(waitForReceipt(service.url, `0x${"1".repeat(64)}`, { fetch, signal: AbortSignal.abort(reason) }),
      (e: unknown) => e === reason);
    assert.equal(calls, 0);
  });

  test("waitForReceipt preserves caller cancellation during a request", { timeout: 2_000 }, async () => {
    const controller = new AbortController();
    const reason = new Error("caller cancelled");
    let requestSignal: AbortSignal | undefined;
    await assert.rejects(waitForReceipt(service.url, `0x${"1".repeat(64)}`, {
      signal: controller.signal,
      fetch: (_input, init) => {
        requestSignal = init?.signal ?? undefined;
        controller.abort(reason);
        return new Promise<Response>(() => {});
      },
    }), (e: unknown) => e === reason);
    assert.equal(requestSignal?.reason, reason);
  });

  test("waitForReceipt cancels a polling sleep without another request", { timeout: 2_000 }, async () => {
    const controller = new AbortController();
    const reason = new Error("caller cancelled");
    let calls = 0;
    let cancel: ReturnType<typeof setTimeout> | undefined;
    try {
      await assert.rejects(waitForReceipt(service.url, `0x${"1".repeat(64)}`, {
        signal: controller.signal, intervalMs: 60_000,
        fetch: async () => {
          calls++;
          return new Response(JSON.stringify({ format: "hemi-agent-receipt", status: { stage: "pending" } }));
        },
        onStatus: () => { cancel = setTimeout(() => controller.abort(reason), 10); },
      }), (e: unknown) => e === reason);
      assert.equal(calls, 1);
    } finally {
      clearTimeout(cancel);
    }
  });
});
