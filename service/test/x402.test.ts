import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer, type AddressInfo, type Socket } from "node:net";
import { fileURLToPath } from "node:url";
import { concatHex, numberToHex, pad, toEventSelector, type Hex } from "viem";
import { freePort } from "@hemi-receipts/e2e/lib";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { decodePaymentRequiredHeader, decodePaymentResponseHeader } from "@x402/core/http";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { PERMIT2_ADDRESS } from "@x402/evm";
import { DEFAULT_PAYMENT_ASSETS } from "../src/config.js";
import type { RunningService } from "../src/service.js";
import { SETTLEMENT_HOLD_MS } from "../src/store.js";
import type { Store } from "../src/store.js";
import { emitLog, installNonceStub, landLastPayment, removeNonceStub, startFakeFacilitator, type FakeFacilitator, type Spend } from "./fake-facilitator.js";
import { accounts, batchCount, get, makeManifest, post, recordingLogger, setupChain, signed, startCrashingChild, startTestService, tempDbPath, testEnv, waitFor, type HttpResult, type TestChain } from "./helpers.js";

const CHAIN_ID = 743_111; // anvil pretends to be Hemi testnet, so the default USDC.e asset applies
const NETWORK = `eip155:${CHAIN_ID}`;
const USDC = DEFAULT_PAYMENT_ASSETS[CHAIN_ID]!.address;
const buyer = accounts.stranger;
const http = new x402HTTPClient(
  new x402Client()
    .register(NETWORK as `${string}:${string}`, new ExactEvmScheme(buyer))
    .setSpendControls({ allowedAssets: [{ network: NETWORK as `${string}:${string}`, asset: USDC, maxAmountPerPayment: "100000" }] }),
);

/** Answers the 402 for this request with a fresh signed payment: the headers to retry with. */
async function paymentAt(url: string, body: unknown, client = http): Promise<Record<string, string>> {
  const challenge = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  assert.equal(challenge.status, 402, `expected a 402 challenge, got ${challenge.status}`);
  const required = client.getPaymentRequiredResponse((name) => challenge.headers.get(name), await challenge.json().catch(() => undefined));
  return client.encodePaymentSignatureHeader(await client.createPaymentPayload(required));
}

/**
 * Half an hour passes for this row: its hold ends, and by default its authorization expires too
 * (buyers sign 5 minutes). `authorizationLive` leaves the deadline the buyer signed, still ahead.
 */
async function endTheHold(store: Store, runId: Hex, options: { authorizationLive?: boolean } = {}): Promise<void> {
  const row = (await store.getReceipt(runId))!;
  const payment = JSON.parse(row.payment_json!);
  const now = Date.now();
  const deadline = options.authorizationLive ? payment.deadline : String(Math.floor(now / 1000) - 1);
  await store.notePayment(runId, row.leaf, { ...payment, deadline, at: now - SETTLEMENT_HOLD_MS - 1 }, now, now - 1);
}

/** The same signed payment with its payload edited: what a buyer replaying one authorization could send. */
function rewritePayment(headers: Record<string, string>, edit: (payment: { payload: Record<string, any> }) => void): Record<string, string> {
  const [name, value] = Object.entries(headers)[0]!;
  const decoded = JSON.parse(Buffer.from(value, "base64").toString("utf8"));
  edit(decoded);
  return { [name]: Buffer.from(JSON.stringify(decoded), "utf8").toString("base64") };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const ENTRY = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const SERVICE_DIR = fileURLToPath(new URL("..", import.meta.url));

/** The real entry point in a child process, so signals reach it as they do in production. */
function startEntry(env: Record<string, string | undefined>) {
  const child = spawn(process.execPath, ["--import", "tsx", ENTRY], { cwd: SERVICE_DIR, env: { ...process.env, ...env } as NodeJS.ProcessEnv, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout!.on("data", (chunk) => (output += String(chunk)));
  child.stderr!.on("data", (chunk) => (output += String(chunk)));
  const exited = once(child, "exit") as Promise<[number | null, NodeJS.Signals | null]>;
  return { child, exited, output: () => output };
}

describe("x402 paywall (fake in-process facilitator)", () => {
  let chain: TestChain;
  let facilitator: FakeFacilitator;
  let service: RunningService;
  let db: ReturnType<typeof tempDbPath>;
  const payTo = accounts.owner.address;

  const paymentFor = (path: string, body: unknown) => paymentAt(`${service.url}${path}`, body);

  /** POST, answer the 402 with a fresh signed payment, POST again with it. */
  async function paidPost(path: string, body: unknown): Promise<HttpResult> {
    return post(`${service.url}${path}`, body, await paymentFor(path, body));
  }

  before(async () => {
    chain = await setupChain({ chainId: CHAIN_ID });
    facilitator = await startFakeFacilitator(NETWORK, buyer.address);
    db = tempDbPath();
    service = await startTestService(
      testEnv(chain, db.path, {
        DEV_FREE: "0",
        PAY_TO: payTo,
        FACILITATOR_URL: facilitator.url,
        PRICE_BATCH: "1000",
        PRICE_DIRECT: "10000",
        BATCH_MAX_SIZE: "2",
        BATCH_MAX_WAIT_SECONDS: "3600",
      }),
    );
  });

  after(async () => {
    await service?.stop();
    await facilitator?.stop();
    await chain?.stop();
    db?.cleanup();
  });

  it("answers an unpaid POST /attest with 402 and payment requirements that decode with @x402/core", async () => {
    const body = await signed(chain, makeManifest());
    const res = await fetch(`${service.url}/attest`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ manifest: body.manifest, agentSignature: body.agentSignature }) });
    assert.equal(res.status, 402);
    const header = res.headers.get("payment-required");
    assert.ok(header, "PAYMENT-REQUIRED header");
    const required = decodePaymentRequiredHeader(header);
    assert.equal(required.x402Version, 2);
    assert.equal(required.accepts.length, 1);
    const [accept] = required.accepts;
    assert.equal(accept!.scheme, "exact");
    assert.equal(accept!.network, NETWORK);
    assert.equal(accept!.asset.toLowerCase(), USDC.toLowerCase());
    assert.equal(accept!.amount, "1000");
    assert.equal(accept!.payTo.toLowerCase(), payTo.toLowerCase());
    assert.equal(accept!.extra?.assetTransferMethod, "permit2");
    assert.equal(await service.store.getReceipt(body.receipt.runId), null, "nothing stored for an unpaid request");

    const direct = await fetch(`${service.url}/attest/direct`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ manifest: body.manifest, agentSignature: body.agentSignature }) });
    assert.equal(direct.status, 402);
    assert.equal(decodePaymentRequiredHeader(direct.headers.get("payment-required")!).accepts[0]!.amount, "10000");
  });

  it("rejects an invalid request with 400 before the paywall: nothing to pay for", async () => {
    const before = { ...facilitator.calls };
    const res = await post(`${service.url}/attest`, { manifest: { ...makeManifest(), receiptVersion: 2 }, agentSignature: `0x${"11".repeat(65)}` });
    assert.equal(res.status, 400);
    const badSig = await signed(chain, makeManifest(), "0x" + "42".repeat(32) as Hex);
    assert.equal((await post(`${service.url}/attest`, { manifest: badSig.manifest, agentSignature: badSig.agentSignature })).status, 400);
    assert.deepEqual({ verify: facilitator.calls.verify, settle: facilitator.calls.settle }, { verify: before.verify, settle: before.settle });
  });

  let paidRunId: Hex;
  it("accepts a paid request: verify, handler, settle, then the receipt is queued; a replay is free", async () => {
    const body = await signed(chain, makeManifest());
    paidRunId = body.receipt.runId;
    const before = { ...facilitator.calls };
    const res = await paidPost("/attest", { manifest: body.manifest, agentSignature: body.agentSignature });
    assert.equal(res.status, 202, JSON.stringify(res.body));
    assert.equal(res.body.runId, body.receipt.runId);
    assert.equal(facilitator.calls.verify, before.verify + 1);
    assert.equal(facilitator.calls.settle, before.settle + 1);
    const settlement = decodePaymentResponseHeader(res.headers.get("payment-response")!);
    assert.equal(settlement.success, true);

    const row = await service.store.getReceipt(body.receipt.runId);
    assert.equal(row?.state, "queued");
    assert.equal(JSON.parse(row!.payment_json!).transaction, settlement.transaction);
    assert.equal((await get(res.body.receiptUrl)).status, 200);

    const replay = await post(`${service.url}/attest`, { manifest: body.manifest, agentSignature: body.agentSignature });
    assert.equal(replay.status, 200, "an identical resubmission is answered without a payment");
    assert.equal(facilitator.calls.verify, before.verify + 1, "no second verify");
    assert.equal(facilitator.calls.settle, before.settle + 1, "no second settle");
  });

  it("leaves nothing queued when settlement fails, and accepts a retry with a valid payment", async () => {
    const body = await signed(chain, makeManifest());
    facilitator.settleMode = "fail";
    const failed = await paidPost("/attest", { manifest: body.manifest, agentSignature: body.agentSignature });
    assert.equal(failed.status, 402, "a failed settlement is answered 402, not the handler's 202");
    const row = await service.store.getReceipt(body.receipt.runId);
    assert.equal(row?.state, "unpaid", "stored only as unpaid, never queued");
    assert.equal((await get(`${service.url}/receipts/${body.receipt.runId}`)).status, 404);
    await service.batcher.tick();
    assert.equal((await service.store.getReceipt(body.receipt.runId))?.state, "unpaid");
    assert.equal((await service.store.counts()).queued, 1, "only the earlier paid receipt is queued");
    assert.equal(await batchCount(chain), 0n, "nothing anchored for free");

    facilitator.settleMode = "ok";
    const retry = await paidPost("/attest", { manifest: body.manifest, agentSignature: body.agentSignature });
    assert.equal(retry.status, 202, JSON.stringify(retry.body));
    // Two paid receipts reach BATCH_MAX_SIZE=2: the batch closes and anchors both.
    for (const runId of [paidRunId, body.receipt.runId]) {
      await waitFor("anchored", async () => (await get(`${service.url}/receipts/${runId}`)).body.anchor);
    }
    assert.equal(await batchCount(chain), 1n);
  });

  it("holds a settlement_pending payment: a retry gets 409 payment_pending instead of a second charge", async () => {
    const body = await signed(chain, makeManifest());
    facilitator.settleMode = "pending";
    const res = await paidPost("/attest", { manifest: body.manifest, agentSignature: body.agentSignature });
    assert.equal(res.status, 402);
    const row = await service.store.getReceipt(body.receipt.runId);
    assert.equal(row?.state, "unpaid");
    assert.equal(JSON.parse(row!.payment_json!).status, "settlement_pending");
    const before = { ...facilitator.calls };
    const retry = await post(`${service.url}/attest`, { manifest: body.manifest, agentSignature: body.agentSignature });
    assert.equal(retry.status, 409);
    assert.equal(retry.body.error, "payment_pending");
    assert.equal(facilitator.calls.verify, before.verify);
    facilitator.settleMode = "ok";
  });

  for (const [mode, how] of [["lost", "the connection drops"], ["bad-gateway", "a proxy answers 502"], ["uncertain", "the facilitator cannot tell"]] as const) {
    it(`holds the receipt when ${how} during settlement: the money may have moved, so a retry is not charged`, async () => {
      const body = await signed(chain, makeManifest());
      const request = { manifest: body.manifest, agentSignature: body.agentSignature };
      facilitator.settleMode = mode;
      const res = await paidPost("/attest", request);
      facilitator.settleMode = "ok";
      assert.equal(res.status, 402);
      const row = await service.store.getReceipt(body.receipt.runId);
      assert.equal(row?.state, "unpaid");
      const payment = JSON.parse(row!.payment_json!);
      assert.equal(payment.status, "settlement_unknown");
      assert.equal(payment.payer.toLowerCase(), buyer.address.toLowerCase(), "the record says who to look for on chain");
      assert.ok(payment.nonce, "and which authorization");
      const { verify, settle } = facilitator.calls;
      const retry = await post(`${service.url}/attest`, request);
      assert.equal(retry.status, 409);
      assert.equal(retry.body.error, "payment_pending");
      assert.equal(facilitator.calls.verify, verify);
      assert.equal(facilitator.calls.settle, settle, "a held receipt never reaches the facilitator");
    });
  }

  for (const reason of ["invalid_transaction_state", "invalid_exact_evm_transaction_failed: execution reverted"]) {
    it(`a failure that names a transaction leaves it to the poller, whatever it says (${reason})`, async () => {
      const body = await signed(chain, makeManifest());
      const request = { manifest: body.manifest, agentSignature: body.agentSignature };
      facilitator.settleMode = "tx-failure";
      facilitator.failureReason = reason;
      const res = await paidPost("/attest", request);
      facilitator.settleMode = "ok";
      assert.equal(res.status, 402);
      const payment = JSON.parse((await service.store.getReceipt(body.receipt.runId))!.payment_json!);
      assert.equal(payment.status, "settlement_pending");
      assert.match(payment.transaction, /^0x[0-9a-f]{64}$/);
      const { settle } = facilitator.calls;
      const retry = await post(`${service.url}/attest`, request);
      assert.equal(retry.status, 409);
      assert.equal(retry.body.error, "payment_pending");
      assert.equal(facilitator.calls.settle, settle);
    });
  }

  it("keeps a settlement_pending transaction when the SDK's automatic retry loses its answer", async () => {
    const body = await signed(chain, makeManifest());
    facilitator.settleMode = "pending-then-lost";
    const res = await paidPost("/attest", { manifest: body.manifest, agentSignature: body.agentSignature });
    facilitator.settleMode = "ok";
    assert.equal(res.status, 402);
    const payment = JSON.parse((await service.store.getReceipt(body.receipt.runId))!.payment_json!);
    assert.equal(payment.status, "settlement_pending");
    assert.match(payment.transaction, /^0x[0-9a-f]{64}$/);
  });

  it("a settlement that has been decided leaves the poller's queue, whatever reason it kept", async () => {
    const body = await signed(chain, makeManifest());
    facilitator.settleMode = "pending";
    await paidPost("/attest", { manifest: body.manifest, agentSignature: body.agentSignature });
    facilitator.settleMode = "ok";
    const row = (await service.store.getReceipt(body.receipt.runId))!;
    const payment = JSON.parse(row.payment_json!);
    assert.equal(payment.reason, "settlement_pending");
    assert.ok((await service.store.pendingSettlements(1000)).some((r) => r.run_id === body.receipt.runId), "queued while pending");
    await service.store.notePayment(body.receipt.runId, row.leaf, { ...payment, status: "settlement_failed" }, Date.now());
    assert.ok(!(await service.store.pendingSettlements(1000)).some((r) => r.run_id === body.receipt.runId), "a decided row must not hold a slot for ever");
  });

  it("a hold with no authorization on record lets the buyer pay again: there is no nonce to read", async () => {
    const body = await signed(chain, makeManifest());
    const request = { manifest: body.manifest, agentSignature: body.agentSignature };
    facilitator.settleMode = "lost";
    await paidPost("/attest/direct", request);
    facilitator.settleMode = "ok";
    const now = Date.now();
    const leaf = (await service.store.getReceipt(body.receipt.runId))!.leaf;
    await service.store.notePayment(body.receipt.runId, leaf, { status: "settlement_unknown", at: now - SETTLEMENT_HOLD_MS - 1 }, now, now - 1);
    const res = await paidPost("/attest/direct", request);
    assert.equal(res.status, 202);
    const row = await service.store.getReceipt(body.receipt.runId);
    assert.equal(JSON.parse(row!.payment_json!).status, "settled");
  });

  it("a payment that cannot be recorded first is never settled: nothing moved, and a retry is served", async () => {
    const body = await signed(chain, makeManifest());
    const request = { manifest: body.manifest, agentSignature: body.agentSignature };
    const { settle } = facilitator.calls;
    const notePayment = service.store.notePayment;
    service.store.notePayment = async () => {
      throw new Error("database is locked");
    };
    let res: HttpResult;
    try {
      res = await paidPost("/attest/direct", request);
    } finally {
      service.store.notePayment = notePayment;
    }
    assert.equal(res.status, 402);
    assert.equal(facilitator.calls.settle, settle, "the facilitator was never asked");
    await service.paywall!.settled();
    const retry = await paidPost("/attest/direct", request);
    assert.equal(retry.status, 202, JSON.stringify(retry.body));
    assert.equal(facilitator.calls.settle, settle + 1);
  });

  it("a settlement_pending hold stops a request that passed the precheck before it: that payment is not settled", async () => {
    const body = await signed(chain, makeManifest());
    const request = { manifest: body.manifest, agentSignature: body.agentSignature };
    const [first, second] = [await paymentFor("/attest", request), await paymentFor("/attest", request)];

    // The second request passes the precheck, then waits in verify.
    let release!: () => void;
    facilitator.verifyHold = new Promise<void>((resolve) => (release = resolve));
    const verifying = facilitator.nextVerify();
    const late = post(`${service.url}/attest`, request, second);
    await verifying;
    facilitator.verifyHold = undefined;

    // The first goes all the way through and ends settlement_pending.
    facilitator.settleMode = "pending";
    const early = await post(`${service.url}/attest`, request, first);
    facilitator.settleMode = "ok";
    assert.equal(early.status, 402);
    const held = await service.store.getReceipt(body.receipt.runId);
    assert.equal(JSON.parse(held!.payment_json!).status, "settlement_pending");
    const { settle } = facilitator.calls;

    release();
    const res = await late;
    assert.equal(res.status, 409);
    assert.equal(res.body.error, "payment_pending");
    assert.equal(facilitator.calls.settle, settle, "the second payment is never settled");
    const row = await service.store.getReceipt(body.receipt.runId);
    assert.equal(row!.payment_json, held!.payment_json, "the pending tx stays on record for the poller");
  });

  it("two requests paying for one receipt settle one payment: the second is refused while the first settles", async () => {
    const body = await signed(chain, makeManifest());
    const request = { manifest: body.manifest, agentSignature: body.agentSignature };
    const [first, second] = [await paymentFor("/attest", request), await paymentFor("/attest", request)];
    const before = { ...facilitator.calls };

    // Hold the first request in its settlement phase: its row is stored unpaid, with the lease.
    let release!: () => void;
    facilitator.settleHold = new Promise<void>((resolve) => (release = resolve));
    const settling = facilitator.nextSettle();
    const a = post(`${service.url}/attest`, request, first);
    try {
      await settling;
      const stored = await service.store.getReceipt(body.receipt.runId);
      assert.equal(stored?.state, "unpaid");
      assert.ok((stored?.settle_lease_until ?? 0) > Date.now() + SETTLEMENT_HOLD_MS - 60_000, "the first request holds the lease, as long as a hold: a kill now must not free the receipt early");
      const record = JSON.parse(stored!.payment_json!);
      assert.equal(record.status, "settling");
      assert.equal(record.payer.toLowerCase(), buyer.address.toLowerCase(), "the payer is on disk before the facilitator is asked");
      assert.equal(record.nonce, facilitator.lastSettleBody.paymentPayload.payload.permit2Authorization.nonce, "and so is the nonce it signed");

      // The second request is refused in the precheck, before its payment is even verified.
      const b = await post(`${service.url}/attest`, request, second);
      assert.equal(b.status, 409, JSON.stringify(b.body));
      assert.equal(b.body.error, "payment_pending");
      assert.equal(b.headers.get("retry-after"), "30");
      assert.equal(facilitator.calls.verify, before.verify + 1, "only the first payment was verified");

      // Another manifest under this run id waits too: the first payment may still take the run id.
      const other = await signed(chain, makeManifest({ runId: body.manifest.runId, model: "another-model" }));
      const c = await post(`${service.url}/attest`, { manifest: other.manifest, agentSignature: other.agentSignature });
      assert.equal(c.status, 409, JSON.stringify(c.body));
      assert.equal(c.body.error, "run_id_conflict");
      assert.equal(c.headers.get("retry-after"), "30");

      // Had both passed the precheck before either stored anything, the handler's rewrite is the claim.
      const rewrite = { ...body.receipt, leaf: stored!.leaf, agentSignature: body.agentSignature, mode: "batch" as const, state: "unpaid" as const, manifestJson: null, directServiceSignature: null, directDeadline: null, settleLeaseUntil: Date.now() + 60_000 };
      assert.equal(await service.store.rewriteUnpaid({ runId: body.receipt.runId, leaf: stored!.leaf }, rewrite, Date.now()), false, "no rewrite while the lease is held");
    } finally {
      // Whatever happened above, let the held settlement finish so later tests are not stuck behind it.
      facilitator.settleHold = undefined;
      release();
    }
    const res = await a;
    assert.equal(res.status, 202, JSON.stringify(res.body));
    assert.equal(facilitator.calls.settle, before.settle + 1, "exactly one settlement");
    assert.equal((await service.store.getReceipt(body.receipt.runId))?.state, "queued");
    const replay = await post(`${service.url}/attest`, request);
    assert.equal(replay.status, 200, "a later retry is the free replay");
    assert.equal(facilitator.calls.settle, before.settle + 1);
  });

  it("one authorization pays for one run id: offered for another run id, even while the first settles, it is never settled", async () => {
    const [a, b] = [await signed(chain, makeManifest()), await signed(chain, makeManifest())];
    const requestA = { manifest: a.manifest, agentSignature: a.agentSignature };
    const requestB = { manifest: b.manifest, agentSignature: b.agentSignature };
    const payment = await paymentFor("/attest", requestA);
    const before = { ...facilitator.calls };

    // A is in its settlement phase, so the authorization is not spent anywhere yet.
    let release!: () => void;
    facilitator.settleHold = new Promise<void>((resolve) => (release = resolve));
    const settling = facilitator.nextSettle();
    const first = post(`${service.url}/attest`, requestA, payment);
    let reused: HttpResult;
    try {
      await settling;
      reused = await post(`${service.url}/attest`, requestB, payment);
    } finally {
      facilitator.settleHold = undefined;
      release();
    }
    assert.equal(reused.status, 402, JSON.stringify(reused.body));
    assert.equal(facilitator.calls.settle, before.settle + 1, "only A's settlement reached the facilitator");
    const rowB = await service.store.getReceipt(b.receipt.runId);
    assert.equal(rowB?.state, "unpaid");
    assert.equal(rowB?.payment_json, null, "nothing on record for B: no hold for recovery to credit later");
    assert.equal(rowB?.settle_lease_until, null);

    const resA = await first;
    assert.equal(resA.status, 202, JSON.stringify(resA.body));
    assert.ok(["queued", "batched"].includes((await service.store.getReceipt(a.receipt.runId))!.state), "A is paid (batched once a batch fills)");

    // Once A is paid the claim stays: the same authorization still cannot pay for B.
    const again = await post(`${service.url}/attest`, requestB, payment);
    assert.equal(again.status, 402);
    assert.equal(facilitator.calls.settle, before.settle + 1, "still one settlement");
    // B pays with an authorization of its own.
    const paid = await paidPost("/attest", requestB);
    assert.equal(paid.status, 202, JSON.stringify(paid.body));
    assert.equal(facilitator.calls.settle, before.settle + 2);
  });

  it("one authorization however it is spelled: a nonce with a leading zero, or a second payload field, is not a new payment", async () => {
    const [a, b, c] = [await signed(chain, makeManifest()), await signed(chain, makeManifest()), await signed(chain, makeManifest())];
    const requestA = { manifest: a.manifest, agentSignature: a.agentSignature };
    const requestB = { manifest: b.manifest, agentSignature: b.agentSignature };
    const requestC = { manifest: c.manifest, agentSignature: c.agentSignature };
    const payment = await paymentFor("/attest", requestA);
    const before = { ...facilitator.calls };
    assert.equal((await post(`${service.url}/attest`, requestA, payment)).status, 202);

    // Permit2 reads "0" + nonce as the same number, so this is still A's authorization.
    const padded = rewritePayment(payment, (p) => void (p.payload.permit2Authorization.nonce = `0${p.payload.permit2Authorization.nonce}`));
    const reused = await post(`${service.url}/attest`, requestB, padded);
    assert.equal(reused.status, 402, JSON.stringify(reused.body));
    assert.equal(facilitator.calls.settle, before.settle + 1, "the zero-padded copy is never settled");
    assert.equal((await service.store.getReceipt(b.receipt.runId))?.payment_json, null);

    // Both payload fields: which nonce gets spent would be the facilitator's choice, so it is refused.
    const both = rewritePayment(await paymentFor("/attest", requestC), (p) => {
      p.payload.authorization = { from: buyer.address, to: payTo, value: "1000", validAfter: "0", validBefore: "9999999999", nonce: `0x${"77".repeat(32)}` };
    });
    const ambiguous = await post(`${service.url}/attest`, requestC, both);
    assert.equal(ambiguous.status, 402, JSON.stringify(ambiguous.body));
    assert.equal(facilitator.calls.settle, before.settle + 1, "nor is the two-field payload");
    assert.equal((await service.store.getReceipt(c.receipt.runId))?.payment_json, null);
  });

  it("a refused submission is replaced at once by a corrected receipt under the same run id, without the old manifest", async () => {
    const first = await signed(chain, makeManifest());
    facilitator.settleMode = "fail";
    const failed = await paidPost("/attest", { manifest: first.manifest, agentSignature: first.agentSignature, store: true });
    assert.equal(failed.status, 402);
    const abandoned = await service.store.getReceipt(first.receipt.runId);
    assert.equal(abandoned?.state, "unpaid");
    assert.ok(abandoned?.manifest_json, "the manifest was stored with the unpaid row");

    // Nobody paid, so the run id is not taken: the buyer's corrected manifest is served straight away.
    facilitator.settleMode = "ok";
    const other = await signed(chain, makeManifest({ runId: first.manifest.runId, model: "another-model" }));
    const res = await paidPost("/attest", { receipt: other.receipt, agentSignature: other.agentSignature });
    assert.equal(res.status, 202, JSON.stringify(res.body));
    const file = await get(res.body.receiptUrl);
    assert.equal(file.body.receipt.manifestHash, other.receipt.manifestHash);
    assert.equal(file.body.manifest, undefined, "the abandoned submission's manifest does not travel with a receipt of another manifest hash");
  });

  it("releases the direct-path signature only after settlement", async () => {
    const body = await signed(chain, makeManifest());
    facilitator.settleMode = "fail";
    const failed = await paidPost("/attest/direct", { manifest: body.manifest, agentSignature: body.agentSignature });
    assert.equal(failed.status, 402);
    assert.equal(failed.body?.serviceSignature, undefined, "no signature in a refused response");

    facilitator.settleMode = "ok";
    const ok = await paidPost("/attest/direct", { manifest: body.manifest, agentSignature: body.agentSignature });
    assert.equal(ok.status, 202, JSON.stringify(ok.body));
    assert.match(ok.body.serviceSignature, /^0x[0-9a-f]{130}$/);
    assert.equal((await service.store.getReceipt(body.receipt.runId))?.state, "direct_signed");
  });
});

describe("x402 across a shutdown", () => {
  let chain: TestChain;
  let facilitator: FakeFacilitator;
  const paidEnv = (dbPath: string) =>
    testEnv(chain, dbPath, { DEV_FREE: "0", PAY_TO: accounts.owner.address, FACILITATOR_URL: facilitator.url, PRICE_BATCH: "1000", PRICE_DIRECT: "10000", BATCH_MAX_SIZE: "2", BATCH_MAX_WAIT_SECONDS: "3600" });
  const paidService = (dbPath: string) => startTestService(paidEnv(dbPath));

  before(async () => {
    chain = await setupChain({ chainId: CHAIN_ID });
    await installNonceStub(chain.anvil.url);
    facilitator = await startFakeFacilitator(NETWORK, buyer.address);
  });

  after(async () => {
    await facilitator?.stop();
    await chain?.stop();
  });

  it("a stop lets a settling request finish, so its answer is not lost", async () => {
    const db = tempDbPath();
    const service = await paidService(db.path);
    try {
      const body = await signed(chain, makeManifest());
      const request = { manifest: body.manifest, agentSignature: body.agentSignature };
      const payment = await paymentAt(`${service.url}/attest`, request);
      let release!: () => void;
      facilitator.settleHold = new Promise<void>((resolve) => (release = resolve));
      const settling = facilitator.nextSettle();
      const answered = post(`${service.url}/attest`, request, payment);
      await settling;
      const stopping = service.stop();
      await assert.rejects(fetch(`${service.url}/health`), "a stop takes no new requests");
      facilitator.settleHold = undefined;
      release();
      assert.equal((await answered).status, 202, "the buyer hears the outcome of what it paid for");
      await stopping;
    } finally {
      await service.stop();
      db.cleanup();
    }
  });

  it("a stop waits for a settlement whose buyer hung up, however often it is asked", async () => {
    const db = tempDbPath();
    const service = await paidService(db.path);
    const body = await signed(chain, makeManifest());
    const request = { manifest: body.manifest, agentSignature: body.agentSignature };
    const payment = await paymentAt(`${service.url}/attest`, request);
    let release!: () => void;
    facilitator.settleHold = new Promise<void>((resolve) => (release = resolve));
    const settling = facilitator.nextSettle();
    const buyerGone = new AbortController();
    void fetch(`${service.url}/attest`, { method: "POST", headers: { "content-type": "application/json", ...payment }, body: JSON.stringify(request), signal: buyerGone.signal }).catch(() => undefined);
    await settling;
    buyerGone.abort();
    await new Promise((resolve) => setTimeout(resolve, 50));
    let stopped = false;
    void service.stop().then(() => (stopped = true));
    void service.stop().then(() => (stopped = true));
    await new Promise((resolve) => setTimeout(resolve, 200));
    const early = stopped;
    facilitator.settleHold = undefined;
    release();
    await service.stop();
    assert.equal(early, false, "the settlement was still running");
    const again = await paidService(db.path);
    try {
      assert.equal((await again.store.getReceipt(body.receipt.runId))?.state, "queued", "its outcome was recorded before the stop finished");
    } finally {
      await again.stop();
      db.cleanup();
    }
  });

  it("a stop waits for a paid request that was still verifying, even if its buyer hangs up while it settles", async () => {
    const db = tempDbPath();
    const service = await paidService(db.path);
    let releaseVerify = () => {};
    let releaseSettle = () => {};
    try {
      const body = await signed(chain, makeManifest());
      const request = { manifest: body.manifest, agentSignature: body.agentSignature };
      const payment = await paymentAt(`${service.url}/attest`, request);
      facilitator.verifyHold = new Promise<void>((resolve) => (releaseVerify = resolve));
      facilitator.settleHold = new Promise<void>((resolve) => (releaseSettle = resolve));
      const verifying = facilitator.nextVerify();
      const settling = facilitator.nextSettle();
      const buyerGone = new AbortController();
      void fetch(`${service.url}/attest`, { method: "POST", headers: { "content-type": "application/json", ...payment }, body: JSON.stringify(request), signal: buyerGone.signal }).catch(() => undefined);
      await verifying;
      // The stop begins before anything is settling: only counting the request itself covers it.
      let stopped = false;
      void service.stop().then(() => (stopped = true));
      facilitator.verifyHold = undefined;
      releaseVerify();
      await settling;
      buyerGone.abort();
      await sleep(200);
      assert.equal(stopped, false, "the settlement is still running");
      facilitator.settleHold = undefined;
      releaseSettle();
      await service.stop();
    } finally {
      facilitator.verifyHold = undefined;
      facilitator.settleHold = undefined;
      releaseVerify();
      releaseSettle();
      await service.stop();
    }
    const again = await paidService(db.path);
    try {
      const rows = await again.db.prepare("SELECT state FROM receipts").all<{ state: string }>();
      assert.deepEqual(rows.results.map((r) => r.state), ["queued"], "its outcome was recorded before the stop finished");
    } finally {
      await again.stop();
      db.cleanup();
    }
  });

  it("a paid request that arrives after a stop began is refused before its payment is verified", async () => {
    const db = tempDbPath();
    const service = await paidService(db.path);
    try {
      const body = await signed(chain, makeManifest());
      const request = { manifest: body.manifest, agentSignature: body.agentSignature };
      const payment = await paymentAt(`${service.url}/attest`, request);
      const { verify } = facilitator.calls;
      // What a stop does first. The listener stays up here, standing in for a connection kept alive.
      service.paywall!.stop();
      const res = await post(`${service.url}/attest`, request, payment);
      assert.equal(res.status, 503, JSON.stringify(res.body));
      assert.equal(res.body.error, "service_stopping");
      assert.equal(facilitator.calls.verify, verify, "never verified, so never settled");
      assert.ok(!(await service.store.getReceipt(body.receipt.runId)), "nothing stored");
    } finally {
      await service.stop();
      db.cleanup();
    }
  });

  it("the entry point: further signals join the stop instead of killing a settling payment", async () => {
    const db = tempDbPath();
    const port = await freePort();
    const url = `http://127.0.0.1:${port}`;
    const service = startEntry(
      testEnv(chain, db.path, { DEV_FREE: "0", PAY_TO: accounts.owner.address, FACILITATOR_URL: facilitator.url, PRICE_BATCH: "1000", PRICE_DIRECT: "10000", BATCH_MAX_WAIT_SECONDS: "3600", PORT: String(port), LOG_LEVEL: "info" }),
    );
    let release = () => {};
    try {
      await waitFor("the service to listen", () => fetch(`${url}/health`).catch(() => undefined), 30_000);
      const body = await signed(chain, makeManifest());
      const request = { manifest: body.manifest, agentSignature: body.agentSignature };
      const payment = await paymentAt(`${url}/attest`, request);
      facilitator.settleHold = new Promise<void>((resolve) => (release = resolve));
      const settling = facilitator.nextSettle();
      const answered = post(`${url}/attest`, request, payment);
      await settling;
      service.child.kill("SIGTERM");
      await sleep(300);
      service.child.kill("SIGTERM");
      service.child.kill("SIGINT");
      await sleep(700);
      assert.equal(service.child.exitCode, null, "still draining");
      assert.equal(service.child.signalCode, null, "not killed by the second signal");
      facilitator.settleHold = undefined;
      release();
      assert.equal((await answered).status, 202, "the buyer hears the outcome of what it paid for");
      const [code] = await service.exited;
      assert.equal(code, 0);
      assert.match(service.output(), /already shutting down/);
    } finally {
      facilitator.settleHold = undefined;
      release();
      if (service.child.exitCode === null && service.child.signalCode === null) service.child.kill("SIGKILL");
    }
    const again = await paidService(db.path);
    try {
      const rows = await again.db.prepare("SELECT state FROM receipts").all<{ state: string }>();
      assert.deepEqual(rows.results.map((r) => r.state), ["queued"]);
    } finally {
      await again.stop();
      db.cleanup();
    }
  });

  it("the entry point: a signal during a stalled startup exits at once", async () => {
    // An RPC that accepts connections and never answers: startup waits on its first call.
    const sockets: Socket[] = [];
    const silent = createServer((socket) => void sockets.push(socket));
    await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
    const db = tempDbPath();
    const service = startEntry(testEnv(chain, db.path, { HEMI_RPC_URLS: `http://127.0.0.1:${(silent.address() as AddressInfo).port}`, LOG_LEVEL: "info" }));
    try {
      await waitFor("startup to reach the RPC", async () => sockets.length > 0, 30_000);
      const sent = Date.now();
      service.child.kill("SIGTERM");
      const exit = await Promise.race([service.exited, sleep(5_000).then(() => undefined)]);
      assert.ok(exit, "exited within 5 s");
      assert.deepEqual(exit, [0, null]);
      assert.ok(Date.now() - sent < 5_000);
      assert.match(service.output(), /stopped during startup/);
    } finally {
      if (service.child.exitCode === null && service.child.signalCode === null) service.child.kill("SIGKILL");
      for (const socket of sockets) socket.destroy();
      silent.close();
      db.cleanup();
    }
  });

  for (const landed of [true, false]) {
    it(`a SIGKILL mid-settlement leaves the nonce on disk, and after the hold the chain decides (the payment ${landed ? "landed" : "never landed"})`, { timeout: 60_000 }, async () => {
      const db = tempDbPath();
      const child = await startCrashingChild(paidEnv(db.path), "none");
      let restarted: RunningService | undefined;
      let release = () => {};
      try {
        const body = await signed(chain, makeManifest());
        const request = { manifest: body.manifest, agentSignature: body.agentSignature };
        const payment = await paymentAt(`${child.url}/attest`, request);
        facilitator.settleHold = new Promise<void>((resolve) => (release = resolve));
        const settling = facilitator.nextSettle();
        const cutOff = post(`${child.url}/attest`, request, payment).catch(() => undefined);
        await settling;
        child.kill();
        const [, signal] = await child.exited;
        assert.equal(signal, "SIGKILL", "killed while the facilitator was settling");
        await cutOff;
        facilitator.settleHold = undefined;
        if (landed) await landLastPayment(chain.anvil.url, facilitator);

        restarted = await paidService(db.path);
        const url = `${restarted.url}/attest`;
        const row = await restarted.store.getReceipt(body.receipt.runId);
        const held = JSON.parse(row!.payment_json!);
        assert.equal(held.status, "settlement_unknown");
        assert.equal(held.interrupted, true);
        assert.equal(held.payer.toLowerCase(), buyer.address.toLowerCase());
        assert.equal(held.nonce, facilitator.lastSettleBody.paymentPayload.payload.permit2Authorization.nonce);
        assert.equal((await post(url, request)).status, 409, "held like any other unknown outcome");

        await endTheHold(restarted.store, body.receipt.runId);
        const { verify, settle } = facilitator.calls;
        const retry = await post(url, request);
        if (landed) {
          assert.equal(retry.status, 200, JSON.stringify(retry.body));
          assert.equal((await restarted.store.getReceipt(body.receipt.runId))?.state, "queued");
          assert.deepEqual([facilitator.calls.verify, facilitator.calls.settle], [verify, settle], "not charged again");
        } else {
          assert.equal(retry.status, 402, "free to pay");
          assert.equal((await post(url, request, await paymentAt(url, request))).status, 202);
          assert.equal(facilitator.calls.settle, settle + 1);
        }
      } finally {
        facilitator.settleHold = undefined;
        release();
        child.kill();
        await restarted?.stop();
        db.cleanup();
      }
    });
  }

  for (const [when, leaseLeft] of [["inside its lease", 60_000], ["after an outage longer than the lease", -1]] as const) {
    it(`a kill before any settlement began is held after a restart ${when}, with a record of it`, async () => {
      const db = tempDbPath();
      const first = await paidService(db.path);
      const body = await signed(chain, makeManifest());
      const now = Date.now();
      // A kill between storing the row and settling, or one left by an older version: nothing about the payment.
      const leaf = `0x${"ab".repeat(32)}` as Hex;
      await first.store.insertReceipt({ ...body.receipt, leaf, agentSignature: body.agentSignature, mode: "batch", state: "unpaid", manifestJson: null, directServiceSignature: null, directDeadline: null, settleLeaseUntil: now + leaseLeft }, now);
      await first.stop();
      const second = await paidService(db.path);
      try {
        const row = await second.store.getReceipt(body.receipt.runId);
        assert.equal(row?.state, "unpaid");
        assert.equal(JSON.parse(row!.payment_json!).status, "settlement_unknown");
        assert.ok((row?.settle_lease_until ?? 0) > Date.now() + SETTLEMENT_HOLD_MS - 60_000, "held like any other unknown outcome");
      } finally {
        await second.stop();
        db.cleanup();
      }
    });
  }
});

const NONCE_CASES = [
  { method: "permit2", asset: USDC, stubAt: PERMIT2_ADDRESS, env: {} },
  {
    method: "eip3009",
    asset: "0xad11a8BEb98bbf61dbb1aa0F6d6F2ECD87b35afA",
    stubAt: "0xad11a8BEb98bbf61dbb1aa0F6d6F2ECD87b35afA",
    env: { PAYMENT_ASSET: "0xad11a8BEb98bbf61dbb1aa0F6d6F2ECD87b35afA", PAYMENT_ASSET_TRANSFER_METHOD: "eip3009", PAYMENT_ASSET_EIP712_NAME: "Bridged USDC (Stargate)", PAYMENT_ASSET_EIP712_VERSION: "2" },
  },
] as const;

for (const { method, asset, stubAt, env } of NONCE_CASES) {
  describe(`x402 when a hold runs out: the payment's nonce decides (${method})`, () => {
    let chain: TestChain;
    let facilitator: FakeFacilitator;
    let service: RunningService;
    let db: ReturnType<typeof tempDbPath>;
    const log = recordingLogger();
    const client = new x402HTTPClient(
      new x402Client()
        .register(NETWORK as `${string}:${string}`, new ExactEvmScheme(buyer))
        .setSpendControls({ allowedAssets: [{ network: NETWORK as `${string}:${string}`, asset, maxAmountPerPayment: "100000" }] }),
    );

    async function paidPost(path: string, request: unknown): Promise<HttpResult> {
      return post(`${service.url}${path}`, request, await paymentAt(`${service.url}${path}`, request, client));
    }

    /** A paid request whose settlement ends in `mode`: the row is held and the payment stands. */
    async function heldPayment(mode: "lost" | "pending", path = "/attest") {
      const body = await signed(chain, makeManifest());
      const request = { manifest: body.manifest, agentSignature: body.agentSignature };
      facilitator.settleMode = mode;
      const res = await paidPost(path, request);
      facilitator.settleMode = "ok";
      assert.equal(res.status, 402);
      return { body, request, runId: body.receipt.runId };
    }
    const land = (how?: Spend) => landLastPayment(chain.anvil.url, facilitator, how);
    const paymentOfRow = async (runId: Hex) => JSON.parse((await service.store.getReceipt(runId))!.payment_json!);
    const calls = () => ({ verify: facilitator.calls.verify, settle: facilitator.calls.settle });

    before(async () => {
      chain = await setupChain({ chainId: CHAIN_ID });
      await installNonceStub(chain.anvil.url, stubAt);
      facilitator = await startFakeFacilitator(NETWORK, buyer.address);
      db = tempDbPath();
      service = await startTestService(
        testEnv(chain, db.path, { DEV_FREE: "0", PAY_TO: accounts.owner.address, FACILITATOR_URL: facilitator.url, PRICE_BATCH: "1000", PRICE_DIRECT: "10000", BATCH_MAX_SIZE: "1000", BATCH_MAX_WAIT_SECONDS: "3600", ...env }),
        { log },
      );
    });

    after(async () => {
      await service?.stop();
      await facilitator?.stop();
      await chain?.stop();
      db?.cleanup();
    });

    it("used, and the transfer to PAY_TO carries its nonce: the receipt is queued without a second charge, and a retry is the free replay", async () => {
      const { request, runId } = await heldPayment("lost");
      const recorded = await paymentOfRow(runId);
      assert.match(recorded.settleBlock, /^\d+$/, "the head was recorded before settling");
      assert.equal(typeof recorded.settleStartedAt, "number");
      await land();
      assert.equal((await post(`${service.url}/attest`, request)).status, 409, "while the hold lasts it only waits");
      await endTheHold(service.store, runId);
      const charged = calls();
      const retry = await post(`${service.url}/attest`, request);
      assert.equal(retry.status, 200, JSON.stringify(retry.body));
      assert.equal(retry.body.receipt.runId, runId);
      assert.deepEqual(calls(), charged, "neither verified nor settled again");
      const row = await service.store.getReceipt(runId);
      assert.equal(row?.state, "queued");
      assert.equal(row?.settle_lease_until, null);
      const payment = JSON.parse(row!.payment_json!);
      assert.equal(payment.status, "settled");
      assert.equal(payment.via, "transfer");
      assert.match(payment.transferTx, /^0x[0-9a-f]{64}$/);
      assert.equal((await get(`${service.url}/receipts/${runId}`)).status, 200);
      assert.equal((await post(`${service.url}/attest`, request)).status, 200);
      assert.deepEqual(calls(), charged);
    });

    it("used, on the direct path: the service signature goes out without a second charge", async () => {
      const { request, runId } = await heldPayment("lost", "/attest/direct");
      await land();
      await endTheHold(service.store, runId);
      const charged = calls();
      const retry = await post(`${service.url}/attest/direct`, request);
      assert.equal(retry.status, 200, JSON.stringify(retry.body));
      assert.match(retry.body.serviceSignature, /^0x[0-9a-f]{130}$/);
      assert.equal((await service.store.getReceipt(runId))?.state, "direct_signed");
      assert.deepEqual(calls(), charged);
    });

    it("used: another receipt under the same run id is refused, the run id is paid for", async () => {
      const { body, runId } = await heldPayment("lost");
      await land();
      await endTheHold(service.store, runId);
      const other = await signed(chain, makeManifest({ runId: body.manifest.runId, model: "another-model" }));
      const res = await post(`${service.url}/attest`, { manifest: other.manifest, agentSignature: other.agentSignature });
      assert.equal(res.status, 409);
      assert.equal(res.body.error, "run_id_conflict");
      assert.equal((await service.store.getReceipt(runId))?.state, "queued");
    });

    it("used, and the same authorization was also offered for another run id: only the run id that claimed it is credited", async () => {
      const [a, b] = [await signed(chain, makeManifest()), await signed(chain, makeManifest())];
      const requestA = { manifest: a.manifest, agentSignature: a.agentSignature };
      const requestB = { manifest: b.manifest, agentSignature: b.agentSignature };
      const payment = await paymentAt(`${service.url}/attest`, requestA, client);
      // A's settlement answer is lost (the facilitator's "already used" for a second settle looks the same).
      facilitator.settleMode = "lost";
      try {
        assert.equal((await post(`${service.url}/attest`, requestA, payment)).status, 402);
        const charged = calls();
        const reused = await post(`${service.url}/attest`, requestB, payment);
        assert.equal(reused.status, 402);
        assert.equal(calls().settle, charged.settle, "never settled for B");
      } finally {
        facilitator.settleMode = "ok";
      }
      assert.equal((await service.store.getReceipt(b.receipt.runId))?.payment_json, null, "B holds nothing a recovery could credit");
      await land();
      await endTheHold(service.store, a.receipt.runId);
      assert.equal((await post(`${service.url}/attest`, requestA)).status, 200, "A is credited from its transfer");
      assert.equal((await service.store.getReceipt(a.receipt.runId))?.state, "queued");
      assert.equal((await post(`${service.url}/attest`, requestB)).status, 402, "B was never paid for, so it pays");
      assert.notEqual((await service.store.getReceipt(b.receipt.runId))?.state, "queued");
    });

    it("a hold that names another receipt's authorization (recorded before claims existed) is released, never credited from that transfer", async () => {
      const a = await heldPayment("lost");
      await land(); // A's payment reaches PAY_TO
      const b = await heldPayment("lost"); // B holds an authorization of its own that never lands
      const recordA = await paymentOfRow(a.runId);
      const rowB = (await service.store.getReceipt(b.runId))!;
      // As an older version could have recorded it: B's hold names A's authorization.
      await service.store.notePayment(b.runId, rowB.leaf, { ...JSON.parse(rowB.payment_json!), payer: recordA.payer, nonce: recordA.nonce }, Date.now(), Date.now() + SETTLEMENT_HOLD_MS);
      await endTheHold(service.store, b.runId);
      await endTheHold(service.store, a.runId);
      const resB = await post(`${service.url}/attest`, b.request);
      assert.equal(resB.status, 402, "B is released: that transfer pays for A");
      assert.ok(log.lines.some((line) => line.includes("pays for another receipt") && line.includes(`runId=${b.runId}`)));
      assert.equal(JSON.parse((await service.store.getReceipt(b.runId))!.payment_json!).reason, "payment_claimed_by_another_receipt");
      assert.equal((await post(`${service.url}/attest`, a.request)).status, 200, "A is still credited from it");
      assert.equal((await service.store.getReceipt(a.runId))?.state, "queued");
    });

    it("used, and the buyer paid PAY_TO the price in a settlement of another nonce, whose amount spells this nonce: not credited", async () => {
      const body = await signed(chain, makeManifest());
      const request = { manifest: body.manifest, agentSignature: body.agentSignature };
      // This nonce is the price itself (1000), so its 32 bytes appear in any settlement of 1000.
      const nonce = method === "permit2" ? "1000" : numberToHex(1000n, { size: 32 });
      const payment = rewritePayment(await paymentAt(`${service.url}/attest`, request, client), (p) => {
        (p.payload.permit2Authorization ?? p.payload.authorization).nonce = nonce;
      });
      facilitator.settleMode = "lost";
      try {
        assert.equal((await post(`${service.url}/attest`, request, payment)).status, 402);
      } finally {
        facilitator.settleMode = "ok";
      }
      await land("other-transfer"); // this nonce spent silently; PAY_TO paid 1000 in a settlement of nonce 1001
      await endTheHold(service.store, body.receipt.runId);
      assert.equal((await post(`${service.url}/attest`, request)).status, 409, "held: that transfer settled another authorization");
      assert.equal((await paymentOfRow(body.receipt.runId)).status, "settlement_unknown");
    });

    it("used by the buyer's own cancel: the receipt is released, and the retry pays", async () => {
      const { request, runId } = await heldPayment("lost");
      await land("cancel");
      await endTheHold(service.store, runId);
      const charged = calls();
      assert.equal((await post(`${service.url}/attest`, request)).status, 402, "nothing was paid, so the buyer pays");
      const released = await paymentOfRow(runId);
      assert.equal(released.status, "settlement_abandoned");
      assert.match(released.cancelTx, /^0x[0-9a-f]{64}$/);
      assert.ok(log.lines.some((line) => line.includes("cancelled a held payment's authorization") && line.includes(`runId=${runId}`)));
      const retry = await paidPost("/attest", request);
      assert.equal(retry.status, 202, JSON.stringify(retry.body));
      assert.equal(facilitator.calls.settle, charged.settle + 1);
    });

    it("used, with neither a transfer nor a cancel in the logs: the hold stays, and the log names the nonce", async () => {
      const { request, runId } = await heldPayment("lost");
      await land("silent");
      await endTheHold(service.store, runId);
      const before = (await service.store.getReceipt(runId))!;
      const charged = calls();
      const retry = await post(`${service.url}/attest`, request);
      assert.equal(retry.status, 409);
      assert.equal(retry.body.error, "payment_pending");
      assert.deepEqual(calls(), charged);
      assert.equal((await service.store.getReceipt(runId))?.payment_json, before.payment_json);
      const { nonce } = JSON.parse(before.payment_json!);
      assert.ok(log.lines.some((line) => line.includes("neither a transfer to PAY_TO carrying it nor a cancel") && line.includes(`runId=${runId}`) && line.includes(String(nonce))));
    });

    it("used, and the buyer paid PAY_TO only for something else: that transfer does not count", async () => {
      const { request, runId } = await heldPayment("lost");
      await land("other-transfer");
      await endTheHold(service.store, runId);
      assert.equal((await post(`${service.url}/attest`, request)).status, 409);
      assert.equal((await paymentOfRow(runId)).status, "settlement_unknown");
    });

    it("a row without a recorded head is searched from when settling began", async () => {
      const { request, runId } = await heldPayment("lost");
      await land();
      await endTheHold(service.store, runId);
      const row = (await service.store.getReceipt(runId))!;
      const { settleBlock: _dropped, ...withoutBlock } = JSON.parse(row.payment_json!);
      await service.store.notePayment(runId, row.leaf, withoutBlock, Date.now(), Date.now() - 1);
      const retry = await post(`${service.url}/attest`, request);
      assert.equal(retry.status, 200, JSON.stringify(retry.body));
      assert.equal((await paymentOfRow(runId)).via, "transfer");
    });

    it("unused: the retry pays, once, and the hold does not come back", async () => {
      const { request, runId } = await heldPayment("lost");
      await endTheHold(service.store, runId);
      const charged = calls();
      assert.equal((await post(`${service.url}/attest`, request)).status, 402, "free to pay");
      const row = await service.store.getReceipt(runId);
      assert.equal(row?.state, "unpaid");
      assert.equal(row?.settle_lease_until, null);
      assert.equal(JSON.parse(row!.payment_json!).status, "settlement_abandoned");
      const retry = await paidPost("/attest", request);
      assert.equal(retry.status, 202, JSON.stringify(retry.body));
      assert.equal(facilitator.calls.settle, charged.settle + 1);
      assert.equal((await paymentOfRow(runId)).status, "settled");
    });

    it("unused, but the authorization can still land: the hold stays", async () => {
      const { request, runId } = await heldPayment("lost");
      await endTheHold(service.store, runId, { authorizationLive: true });
      const charged = calls();
      const retry = await post(`${service.url}/attest`, request);
      assert.equal(retry.status, 409);
      assert.equal(retry.body.error, "payment_pending");
      assert.deepEqual(calls(), charged);
      assert.equal((await paymentOfRow(runId)).status, "settlement_unknown");
      assert.ok(log.lines.some((line) => line.includes("can still land") && line.includes(`runId=${runId}`)));
    });

    it("the read fails: the hold stays, the log says so, and the chain still decides later", async () => {
      const { request, runId } = await heldPayment("lost");
      await land();
      await endTheHold(service.store, runId);
      const before = (await service.store.getReceipt(runId))!;
      await removeNonceStub(chain.anvil.url, stubAt);
      try {
        const charged = calls();
        const retry = await post(`${service.url}/attest`, request);
        assert.equal(retry.status, 409);
        assert.equal(retry.body.error, "payment_pending");
        assert.equal(retry.headers.get("retry-after"), "60");
        assert.deepEqual(calls(), charged, "a read that failed never lets a payment through");
        const row = await service.store.getReceipt(runId);
        assert.equal(row?.payment_json, before.payment_json);
        assert.ok(log.lines.some((line) => line.includes("could not read a held payment's nonce") && line.includes(`runId=${runId}`)));
      } finally {
        await installNonceStub(chain.anvil.url, stubAt);
      }
      assert.equal((await post(`${service.url}/attest`, request)).status, 200);
    });

    it("the poller gives up on a named transaction whose nonce is used: the receipt is accepted", async () => {
      const { runId } = await heldPayment("pending");
      const { transaction } = await paymentOfRow(runId);
      await land();
      await endTheHold(service.store, runId);
      const charged = calls();
      await waitFor("the poller to accept it", async () => (await service.store.getReceipt(runId))?.state === "queued");
      const payment = await paymentOfRow(runId);
      assert.equal(payment.status, "settled");
      assert.equal(payment.via, "transfer");
      assert.equal(payment.transaction, transaction, "the hash it had is kept");
      assert.notEqual(payment.transferTx, transaction, "the transfer was found under another hash");
      assert.deepEqual(calls(), charged);
    });

    it("the poller gives up on a named transaction whose nonce is unused: the receipt is released", async () => {
      const { request, runId } = await heldPayment("pending");
      await endTheHold(service.store, runId);
      await waitFor("the poller to release it", async () => (await paymentOfRow(runId)).status === "settlement_abandoned");
      assert.equal((await service.store.getReceipt(runId))?.settle_lease_until, null);
      assert.equal((await paidPost("/attest", request)).status, 202);
    });

    it("the poller cannot read the nonce: the named transaction stays held and in its queue", async () => {
      const { request, runId } = await heldPayment("pending");
      await land();
      await removeNonceStub(chain.anvil.url, stubAt);
      try {
        await endTheHold(service.store, runId);
        await waitFor("the poller to say so", async () => log.lines.some((line) => line.includes("could not read a held payment's nonce") && line.includes(`runId=${runId}`)));
        assert.equal((await paymentOfRow(runId)).status, "settlement_pending");
        assert.ok((await service.store.pendingSettlements(1000)).some((row) => row.run_id === runId), "still the poller's to decide");
        const charged = calls();
        assert.equal((await post(`${service.url}/attest`, request)).status, 409);
        assert.deepEqual(calls(), charged);
      } finally {
        await installNonceStub(chain.anvil.url, stubAt);
      }
      await waitFor("the poller to accept it", async () => (await service.store.getReceipt(runId))?.state === "queued");
    });

    it("a decision that took too long does not overwrite the retry that owns the row by now", async () => {
      const { runId } = await heldPayment("lost");
      const stale = (await service.store.getReceipt(runId))!;
      const record = JSON.parse(stale.payment_json!);
      await service.store.notePayment(runId, stale.leaf, { status: "settling", at: Date.now() }, Date.now(), Date.now() + SETTLEMENT_HOLD_MS);
      const ended = await service.store.endHold(runId, stale.leaf, stale.payment_json!, { ...record, status: "settlement_abandoned" }, Date.now());
      assert.equal(ended, false);
      const row = await service.store.getReceipt(runId);
      assert.equal(JSON.parse(row!.payment_json!).status, "settling");
      assert.ok((row?.settle_lease_until ?? 0) > Date.now(), "the lease that protects the retry survives");
    });

    if (method === "permit2") {
      it("reads this nonce's own bit: every other nonce in its word spent is still unused", async () => {
        const { request, runId } = await heldPayment("lost");
        await landLastPayment(chain.anvil.url, facilitator, "neighbours");
        await endTheHold(service.store, runId);
        assert.equal((await post(`${service.url}/attest`, request)).status, 402);
        assert.equal((await paymentOfRow(runId)).status, "settlement_abandoned");
      });

      it("a cancel of the other nonces in its word is not a cancel of this one", async () => {
        const { request, runId } = await heldPayment("lost");
        await land("silent");
        const { paymentPayload } = facilitator.lastSettleBody;
        const nonce = BigInt(paymentPayload.payload.permit2Authorization.nonce);
        const others = (2n ** 256n - 1n) ^ (1n << (nonce & 0xffn));
        await emitLog(chain.anvil.url, buyer.address, PERMIT2_ADDRESS, [toEventSelector("UnorderedNonceInvalidation(address,uint256,uint256)"), pad(buyer.address)], concatHex([numberToHex(nonce >> 8n, { size: 32 }), numberToHex(others, { size: 32 })]));
        await endTheHold(service.store, runId);
        assert.equal((await post(`${service.url}/attest`, request)).status, 409, "neither paid nor cancelled: held");
        assert.equal((await paymentOfRow(runId)).status, "settlement_unknown");
      });
    }
  });
}

describe("x402 with the facilitator down: price discovery still works", () => {
  let chain: TestChain;
  let up: FakeFacilitator;
  let down: FakeFacilitator | undefined;
  let withFacilitator: RunningService;
  let withoutFacilitator: RunningService;
  let downPort: number;
  const dbs: ReturnType<typeof tempDbPath>[] = [];
  const buyer = accounts.stranger;
  const http = new x402HTTPClient(
    new x402Client()
      .register(NETWORK as `${string}:${string}`, new ExactEvmScheme(buyer))
      .setSpendControls({ allowedAssets: [{ network: NETWORK as `${string}:${string}`, asset: USDC, maxAmountPerPayment: "100000" }] }),
  );
  const paidEnv = (facilitatorUrl: string) => {
    const db = tempDbPath();
    dbs.push(db);
    return testEnv(chain, db.path, { DEV_FREE: "0", PAY_TO: accounts.owner.address, FACILITATOR_URL: facilitatorUrl, BATCH_MAX_WAIT_SECONDS: "3600" });
  };
  const challenge = async (service: RunningService, path: string, body: unknown) => {
    const res = await fetch(`${service.url}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, header: res.headers.get("payment-required"), body: await res.json().catch(() => undefined), headers: res.headers };
  };

  before(async () => {
    chain = await setupChain({ chainId: CHAIN_ID });
    up = await startFakeFacilitator(NETWORK, buyer.address);
    // A facilitator URL with nothing listening: start one to get a free port, then stop it.
    const placeholder = await startFakeFacilitator(NETWORK, buyer.address);
    downPort = Number(new URL(placeholder.url).port);
    await placeholder.stop();
    withFacilitator = await startTestService(paidEnv(up.url));
    withoutFacilitator = await startTestService(paidEnv(`http://127.0.0.1:${downPort}`));
  });

  after(async () => {
    await withFacilitator?.stop();
    await withoutFacilitator?.stop();
    await up?.stop();
    await down?.stop();
    await chain?.stop();
    for (const db of dbs) db.cleanup();
  });

  it("answers an unpaid request with the same 402 as when the facilitator is up", async () => {
    const body = await signed(chain, makeManifest());
    const request = { manifest: body.manifest, agentSignature: body.agentSignature };
    for (const path of ["/attest", "/attest/direct"]) {
      const reference = await challenge(withFacilitator, path, request);
      const offline = await challenge(withoutFacilitator, path, request);
      assert.equal(reference.status, 402);
      assert.equal(offline.status, 402, `${path}: ${JSON.stringify(offline.body)}`);
      const expected = decodePaymentRequiredHeader(reference.header!);
      const actual = decodePaymentRequiredHeader(offline.header!);
      assert.deepEqual(actual.accepts, expected.accepts, "identical payment requirements");
      assert.equal(actual.x402Version, 2);
      assert.equal(actual.resource.url.replace(/:\d+\//, ":PORT/"), expected.resource.url.replace(/:\d+\//, ":PORT/"));
      assert.deepEqual(offline.body, reference.body);
    }
    const [accept] = decodePaymentRequiredHeader((await challenge(withoutFacilitator, "/attest", request)).header!).accepts;
    assert.equal(accept!.scheme, "exact");
    assert.equal(accept!.network, NETWORK);
    assert.equal(accept!.asset.toLowerCase(), USDC.toLowerCase());
    assert.equal(accept!.amount, "1000");
    assert.equal(accept!.payTo.toLowerCase(), accounts.owner.address.toLowerCase());
    assert.equal(accept!.extra?.assetTransferMethod, "permit2");
  });

  it("answers a request that carries a payment with 503 payment_unavailable, storing nothing", async () => {
    const body = await signed(chain, makeManifest());
    const request = { manifest: body.manifest, agentSignature: body.agentSignature };
    const first = await challenge(withoutFacilitator, "/attest", request);
    const required = http.getPaymentRequiredResponse((name) => first.headers.get(name), first.body);
    const payment = http.encodePaymentSignatureHeader(await http.createPaymentPayload(required));
    const res = await post(`${withoutFacilitator.url}/attest`, request, payment);
    assert.equal(res.status, 503);
    assert.equal(res.body.error, "payment_unavailable");
    assert.equal(res.headers.get("retry-after"), "30");
    assert.equal(await withoutFacilitator.store.getReceipt(body.receipt.runId), null);
  });

  it("serves paid requests once the facilitator comes back", async () => {
    down = await startFakeFacilitator(NETWORK, buyer.address, downPort);
    const body = await signed(chain, makeManifest());
    const request = { manifest: body.manifest, agentSignature: body.agentSignature };
    const first = await challenge(withoutFacilitator, "/attest", request);
    const required = http.getPaymentRequiredResponse((name) => first.headers.get(name), first.body);
    const res = await post(`${withoutFacilitator.url}/attest`, request, http.encodePaymentSignatureHeader(await http.createPaymentPayload(required)));
    assert.equal(res.status, 202, JSON.stringify(res.body));
    assert.equal(down.calls.verify, 1);
    assert.equal(down.calls.settle, 1);
    assert.equal((await withoutFacilitator.store.getReceipt(body.receipt.runId))?.state, "queued");
  });
});
