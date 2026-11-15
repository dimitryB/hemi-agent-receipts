/**
 * Live x402 integration, skipped unless all three are set:
 *   X402_IT_FACILITATOR_URL    a running Hemi facilitator (https://github.com/dimitryB/x402facilitator)
 *   X402_IT_BUYER_PRIVATE_KEY  a buyer holding USDC.e on Hemi testnet, with Permit2 approved
 *   X402_IT_RPC_URL            a Hemi testnet RPC (or fork) for the buyer's allowance check
 * Optional: X402_IT_PAY_TO (default: the buyer's own address, so funds stay with the buyer).
 *
 * The registry is deployed on a local anvil that reports chain id 743111, so anchoring is
 * local; only the payment goes through the facilitator to Hemi testnet. This test sends no
 * transaction itself: if the Permit2 allowance is missing it fails and says so.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createPublicClient, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { decodePaymentResponseHeader } from "@x402/core/http";
import { ExactEvmScheme, getPermit2AllowanceReadParams } from "@x402/evm/exact/client";
import { DEFAULT_PAYMENT_ASSETS } from "../src/config.js";
import type { RunningService } from "../src/service.js";
import { get, makeManifest, post, setupChain, signed, startTestService, tempDbPath, testEnv, waitFor, type TestChain } from "./helpers.js";

const FACILITATOR = process.env.X402_IT_FACILITATOR_URL;
const BUYER_KEY = process.env.X402_IT_BUYER_PRIVATE_KEY as Hex | undefined;
const RPC = process.env.X402_IT_RPC_URL;
const enabled = Boolean(FACILITATOR && BUYER_KEY && RPC);
const CHAIN_ID = 743_111;
const NETWORK = `eip155:${CHAIN_ID}` as const;
const USDC = DEFAULT_PAYMENT_ASSETS[CHAIN_ID]!.address;
const PRICE = "1000";

describe("x402 live integration (real facilitator)", { skip: enabled ? false : "set X402_IT_FACILITATOR_URL, X402_IT_BUYER_PRIVATE_KEY and X402_IT_RPC_URL to run" }, () => {
  let chain: TestChain;
  let service: RunningService;
  let db: ReturnType<typeof tempDbPath>;
  const buyer = enabled ? privateKeyToAccount(BUYER_KEY!) : undefined;

  before(async () => {
    const reader = createPublicClient({ transport: http(RPC!) });
    assert.equal(await reader.getChainId(), CHAIN_ID, "X402_IT_RPC_URL must be Hemi testnet (or a fork of it)");
    const allowance = (await reader.readContract(getPermit2AllowanceReadParams({ tokenAddress: USDC, ownerAddress: buyer!.address }))) as bigint;
    assert.ok(allowance >= BigInt(PRICE), `buyer ${buyer!.address} has not approved Permit2 for USDC.e (allowance ${allowance}); approve once, then rerun`);

    chain = await setupChain({ chainId: CHAIN_ID });
    db = tempDbPath();
    service = await startTestService(
      testEnv(chain, db.path, {
        DEV_FREE: "0",
        FACILITATOR_URL: FACILITATOR,
        PAY_TO: (process.env.X402_IT_PAY_TO as Address | undefined) ?? buyer!.address,
        PRICE_BATCH: PRICE,
        BATCH_MAX_WAIT_SECONDS: "1",
      }),
    );
    await service.paywall!.ready();
  });

  after(async () => {
    await service?.stop();
    await chain?.stop();
    db?.cleanup();
  });

  it("pays for POST /attest through the facilitator; the receipt is queued only after settlement and then anchored", { timeout: 180_000 }, async () => {
    const body = await signed(chain, makeManifest());
    const request = { manifest: body.manifest, agentSignature: body.agentSignature };
    const challenge = await fetch(`${service.url}/attest`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request) });
    assert.equal(challenge.status, 402);

    const httpClient = new x402HTTPClient(
      new x402Client().register(NETWORK, new ExactEvmScheme(buyer!)).setSpendControls({ allowedAssets: [{ network: NETWORK, asset: USDC, maxAmountPerPayment: PRICE }] }),
    );
    const required = httpClient.getPaymentRequiredResponse((name) => challenge.headers.get(name), await challenge.json().catch(() => undefined));
    const payload = await httpClient.createPaymentPayload(required);
    const paid = await post(`${service.url}/attest`, request, httpClient.encodePaymentSignatureHeader(payload));
    assert.equal(paid.status, 202, JSON.stringify(paid.body));
    const settlement = decodePaymentResponseHeader(paid.headers.get("payment-response")!);
    assert.equal(settlement.success, true);
    assert.match(settlement.transaction, /^0x[0-9a-fA-F]{64}$/);
    const row = await service.store.getReceipt(body.receipt.runId);
    assert.ok(row && row.state !== "unpaid", "promoted after settlement");

    const anchor = await waitFor("anchored", async () => (await get(paid.body.receiptUrl)).body.anchor, 60_000);
    assert.equal(anchor.mode, "batch");
  });
});
