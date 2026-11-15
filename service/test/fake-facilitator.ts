import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { PERMIT2_ADDRESS } from "@x402/evm";
import { concatHex, encodeAbiParameters, keccak256, numberToHex, pad, toEventSelector, type Address, type Hex } from "viem";

/**
 * In-process x402 facilitator for tests: /supported, /verify, /settle with the response
 * shapes HTTPFacilitatorClient expects (verdicts as HTTP 200, as the TS reference does).
 * It never touches a chain; `settleMode` decides what /settle answers. "lost", "bad-gateway" and
 * "uncertain" stand for a settlement that may have moved the money without saying so.
 */
export type SettleMode = "ok" | "fail" | "pending" | "lost" | "bad-gateway" | "uncertain" | "tx-failure" | "pending-then-lost";

export interface FakeFacilitator {
  url: string;
  settleMode: SettleMode;
  /** The reason "tx-failure" answers with, alongside a transaction hash. */
  failureReason: string;
  verifyValid: boolean;
  calls: { supported: number; verify: number; settle: number };
  lastSettleBody: any;
  /** While set, /settle waits for it before answering: holds a request in its settlement phase. */
  settleHold?: Promise<void>;
  /** Resolves when the next /settle request arrives (before any hold). */
  nextSettle(): Promise<void>;
  /** While set, /verify waits for it before answering: holds a request between precheck and handler. */
  verifyHold?: Promise<void>;
  /** Resolves when the next /verify request arrives (before any hold). */
  nextVerify(): Promise<void>;
  stop(): Promise<void>;
}

export async function startFakeFacilitator(network: string, payer: Address, port = 0): Promise<FakeFacilitator> {
  const state: FakeFacilitator = {
    url: "",
    settleMode: "ok",
    failureReason: "invalid_transaction_state",
    verifyValid: true,
    calls: { supported: 0, verify: 0, settle: 0 },
    lastSettleBody: undefined,
    nextSettle: () => new Promise<void>((resolve) => settleWaiters.push(resolve)),
    nextVerify: () => new Promise<void>((resolve) => verifyWaiters.push(resolve)),
    stop: async () => undefined,
  };
  const settleWaiters: (() => void)[] = [];
  const verifyWaiters: (() => void)[] = [];
  let settled = 0;
  let answeredPending = false;
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.get("/supported", (_req, res) => {
    state.calls.supported++;
    res.json({ kinds: [{ x402Version: 2, scheme: "exact", network }], extensions: [], signers: { [network]: [payer] } });
  });
  app.post("/verify", async (_req, res) => {
    state.calls.verify++;
    for (const waiter of verifyWaiters.splice(0)) waiter();
    if (state.verifyHold) await state.verifyHold;
    res.json(state.verifyValid ? { isValid: true, payer } : { isValid: false, invalidReason: "insufficient_funds", payer });
  });
  app.post("/settle", async (req, res) => {
    state.calls.settle++;
    state.lastSettleBody = req.body;
    for (const waiter of settleWaiters.splice(0)) waiter();
    if (state.settleHold) await state.settleHold;
    settled++;
    const transaction = `0x${settled.toString(16).padStart(64, "0")}` as Hex;
    if (state.settleMode === "ok") res.json({ success: true, transaction, network, payer, amount: req.body?.paymentRequirements?.amount });
    else if (state.settleMode === "pending") res.json({ success: false, errorReason: "settlement_pending", errorMessage: "receipt timeout", transaction, network, payer });
    else if (state.settleMode === "lost") res.socket?.destroy();
    else if (state.settleMode === "bad-gateway") res.status(502).send("Bad Gateway");
    else if (state.settleMode === "tx-failure") res.json({ success: false, errorReason: state.failureReason, transaction, network, payer });
    else if (state.settleMode === "pending-then-lost" && answeredPending) {
      answeredPending = false;
      res.socket?.destroy();
    } else if (state.settleMode === "pending-then-lost") {
      answeredPending = true;
      res.json({ success: false, errorReason: "settlement_pending", errorMessage: "receipt timeout", transaction, network, payer });
    } else if (state.settleMode === "uncertain") res.json({ success: false, errorReason: "unexpected_settle_error", transaction: "", network, payer });
    else res.json({ success: false, errorReason: "insufficient_funds", transaction: "", network, payer });
  });
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(port, "127.0.0.1", () => resolve(s));
  });
  state.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  state.stop = async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  return state;
}

/**
 * Stands in for Permit2 and for an EIP-3009 token on a bare anvil, so the service's real reads
 * run. A call of exactly 0x44 bytes, `f(address owner, uint256 key)`, answers mapping[owner][key]
 * at slot 0, which fits both `nonceBitmap(owner, wordPos)` and `authorizationState(authorizer,
 * nonce)`. Any other call emits a log from this address: after a 4-byte selector, a word with the
 * topic count (1 to 3), a word with the data length, the topics, then the data; anything after
 * that is ignored, and is where a transaction can carry a nonce.
 */
const NONCE_STUB: Hex =
  "0x3660441460505760243560043560051b604401600037600435806001146036576002146042576084356064356044356024356000a3005b506044356024356000a1005b6064356044356024356000a2005b6004356000526000602052604060002060205260243560005260406000205460005260206000f3";

async function anvilRpc<T = unknown>(rpcUrl: string, method: string, params: unknown[]): Promise<T> {
  const res = await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const body = (await res.json()) as { result?: T; error?: { message: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result as T;
}

/**
 * Has the stub at `address` emit one log, in a mined transaction from `from` (an anvil dev
 * account) whose input ends with `trailer`.
 */
export async function emitLog(rpcUrl: string, from: Address, address: Address, topics: Hex[], data: Hex, trailer: Hex = "0x"): Promise<Hex> {
  await anvilRpc(rpcUrl, "anvil_setCode", [address, NONCE_STUB]); // keeps the storage: the nonce state stays
  const input = concatHex(["0xdeadbeef", numberToHex(topics.length, { size: 32 }), numberToHex((data.length - 2) / 2, { size: 32 }), ...topics, data, trailer]);
  const hash = await anvilRpc<Hex>(rpcUrl, "eth_sendTransaction", [{ from, to: address, data: input, gas: numberToHex(200_000) }]);
  for (let i = 0; i < 100; i++) {
    const receipt = await anvilRpc<{ status: Hex } | null>(rpcUrl, "eth_getTransactionReceipt", [hash]);
    if (receipt) {
      if (receipt.status !== "0x1") throw new Error(`emitLog: ${hash} reverted`);
      return hash;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`emitLog: ${hash} was not mined`);
}

const TRANSFER = toEventSelector("Transfer(address,address,uint256)");
const AUTHORIZATION_CANCELED = toEventSelector("AuthorizationCanceled(address,bytes32)");
const UNORDERED_NONCE_INVALIDATION = toEventSelector("UnorderedNonceInvalidation(address,uint256,uint256)");
const word = (value: bigint) => numberToHex(value, { size: 32 });

export const installNonceStub = (rpcUrl: string, address: Address = PERMIT2_ADDRESS) => anvilRpc(rpcUrl, "anvil_setCode", [address, NONCE_STUB]);

/** With no code at the address the service's nonce read fails. */
export const removeNonceStub = (rpcUrl: string, address: Address = PERMIT2_ADDRESS) => anvilRpc(rpcUrl, "anvil_setCode", [address, "0x"]);

/**
 * How the nonce of the payment last sent to /settle gets spent on chain:
 * - "transfer": the payment landed. The nonce is spent and the asset logs a Transfer to PAY_TO
 *   in a transaction that carries the nonce, as a facilitator's settlement does.
 * - "cancel": the buyer cancelled it. The nonce is spent and the contract that keeps it logs
 *   the cancel (EIP-3009 AuthorizationCanceled, Permit2 UnorderedNonceInvalidation).
 * - "silent": the nonce is spent and nothing is logged, as when an RPC misses the logs.
 * - "other-transfer": the nonce is spent silently, and the buyer pays PAY_TO in a transaction
 *   that carries a different nonce: a payment for something else.
 * - "neighbours" (Permit2): every other nonce in the same word is spent instead of this one.
 */
export type Spend = "transfer" | "cancel" | "silent" | "other-transfer" | "neighbours";

export async function landLastPayment(rpcUrl: string, facilitator: FakeFacilitator, how: Spend = "transfer"): Promise<void> {
  const { paymentPayload, paymentRequirements } = facilitator.lastSettleBody;
  const { authorization, permit2Authorization } = paymentPayload.payload as {
    authorization?: { from: Address; nonce: Hex };
    permit2Authorization?: { from: Address; nonce: string };
  };
  const payer = (authorization ?? permit2Authorization)!.from;
  const nonce = BigInt((authorization ?? permit2Authorization)!.nonce);
  const asset = paymentRequirements.asset as Address;
  const mappingSlot = (owner: Address, key: bigint) =>
    keccak256(encodeAbiParameters([{ type: "uint256" }, { type: "bytes32" }], [key, keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [owner, 0n]))]));

  if (authorization) {
    await anvilRpc(rpcUrl, "anvil_setStorageAt", [asset, mappingSlot(payer, nonce), numberToHex(1n, { size: 32 })]);
  } else {
    const bit = 1n << (nonce & 0xffn);
    const bits = how === "neighbours" ? (2n ** 256n - 1n) ^ bit : bit;
    await anvilRpc(rpcUrl, "anvil_setStorageAt", [PERMIT2_ADDRESS, mappingSlot(payer, nonce >> 8n), numberToHex(bits, { size: 32 })]);
  }

  const transfer = (carried: bigint) =>
    emitLog(rpcUrl, payer, asset, [TRANSFER, pad(payer), pad(paymentRequirements.payTo as Address)], word(BigInt(paymentRequirements.amount)), word(carried));
  if (how === "transfer") await transfer(nonce);
  else if (how === "other-transfer") await transfer(nonce ^ 1n);
  else if (how === "cancel" && authorization) await emitLog(rpcUrl, payer, asset, [AUTHORIZATION_CANCELED, pad(payer), word(nonce)], "0x");
  else if (how === "cancel") await emitLog(rpcUrl, payer, PERMIT2_ADDRESS, [UNORDERED_NONCE_INVALIDATION, pad(payer)], concatHex([word(nonce >> 8n), word(1n << (nonce & 0xffn))]));
}
