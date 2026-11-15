import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { encodeFunctionData, type Address, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  hashManifest,
  receiptDigest,
  receiptRegistryAbi,
  recoverReceiptSigner,
  registryDomain,
  resolveStatus,
  serviceAttestationTypedData,
  validateManifest,
  type DirectAttestation,
  type ManifestV1,
  type ReceiptFields,
  type ReceiptFile,
  type ReceiptStage,
  type StatusInfo,
} from "@hemi-receipts/sdk";
import type { AnchorResult, SignedReceipt } from "./anchor.js";
import { ANVIL_KEYS, ROLE } from "./anvil.js";

/**
 * An in-process stand-in for the receipts service HTTP API, for SDK and CLI tests:
 *   GET /health, POST /attest, POST /attest/direct, GET /receipts/:runId.
 * It checks what the real service checks at the door (manifest validity, agent signature,
 * runId reuse) and keeps everything in memory. Anchoring happens when the test calls
 * `flush()`: with an `anchor` function (e.g. anchorBatch on anvil) receipts get real
 * anchors and their status is read from the chain; without one, tests set stages by hand.
 */
export interface FakeServiceOptions {
  chainId: number;
  registry: Address;
  /** Anchors pending receipts (batch path). Called by flush(). */
  anchor?: (items: SignedReceipt[]) => Promise<AnchorResult>;
  /** Anchors one receipt immediately (direct path). */
  anchorDirect?: (item: SignedReceipt) => Promise<AnchorResult>;
  /** For status reads of anchored receipts. Without it, the stage is whatever setStage set. */
  client?: PublicClient;
  confirmations?: number;
  /** When set, POST /attest* answers 402 until the request carries a PAYMENT-SIGNATURE header. */
  payment?: { accepts: Record<string, unknown>[]; description?: string };
  /** Countersigns direct attestations. Default: the anvil service key. */
  serviceKey?: Hex;
}

interface Entry {
  receipt: ReceiptFields;
  agentSignature: Hex;
  manifest?: ManifestV1;
  stored: boolean;
  anchor: ReceiptFile["anchor"];
  stage: ReceiptStage;
  /** Set for a direct submission: what the real service answers (and answers again on a replay). */
  direct?: DirectAttestation & { receiptUrl: string };
}

export interface FakeService {
  url: string;
  /** Every request the service received, in order. */
  requests: { method: string; path: string; headers: IncomingMessage["headers"]; body: unknown }[];
  /** Decoded PAYMENT-SIGNATURE payloads the service accepted. */
  payments: unknown[];
  /** While true, a paid POST /attest* is taken and its connection cut with no answer, as when the service dies mid-settlement. */
  dropPaid: boolean;
  entries: Map<string, Entry>;
  /** Anchors every pending receipt with options.anchor. */
  flush(): Promise<AnchorResult | undefined>;
  setStage(runId: string, stage: ReceiptStage): void;
  stop(): Promise<void>;
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return Symbol.for("invalid-json");
  }
}

export async function startFakeService(options: FakeServiceOptions): Promise<FakeService> {
  const entries = new Map<string, Entry>();
  const requests: FakeService["requests"] = [];
  const payments: unknown[] = [];
  let dropPaid = false;
  const domain = registryDomain(options.chainId, options.registry);
  let base = "";

  async function statusOf(entry: Entry): Promise<StatusInfo> {
    const checkedAt = Math.floor(Date.now() / 1000);
    if (entry.stage === "voided") return { stage: "voided", estimated: false, checkedAt };
    if (entry.anchor && options.client) {
      return resolveStatus({ client: options.client, blockNumber: BigInt(entry.anchor.blockNumber), confirmations: options.confirmations });
    }
    return { stage: entry.stage, estimated: false, checkedAt };
  }

  async function fileOf(entry: Entry): Promise<ReceiptFile & { status: StatusInfo }> {
    const file: ReceiptFile & { status: StatusInfo } = {
      format: "hemi-agent-receipt",
      formatVersion: 1,
      chainId: options.chainId,
      registry: options.registry,
      receipt: entry.receipt,
      agentSignature: entry.agentSignature,
      anchor: entry.anchor,
      status: await statusOf(entry),
    };
    if (entry.stored && entry.manifest) file.manifest = entry.manifest;
    return file;
  }

  async function attest(req: IncomingMessage, res: ServerResponse, body: unknown, direct: boolean): Promise<void> {
    if (options.payment && !req.headers["payment-signature"]) {
      const required = {
        x402Version: 2,
        error: "Payment required",
        resource: { url: `${base}${req.url}`, description: options.payment.description ?? "Anchor an agent receipt", mimeType: "application/json" },
        accepts: options.payment.accepts,
      };
      send(res, 402, {}, { "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(required)).toString("base64") });
      return;
    }
    if (options.payment) payments.push(JSON.parse(Buffer.from(String(req.headers["payment-signature"]), "base64").toString("utf8")));
    if (options.payment && dropPaid) {
      res.socket?.destroy();
      return;
    }

    if (typeof body !== "object" || body === null) return send(res, 400, { error: "body must be a JSON object" });
    const b = body as { manifest?: unknown; receipt?: ReceiptFields; agentSignature?: Hex; store?: boolean };
    if (typeof b.agentSignature !== "string") return send(res, 400, { error: "agentSignature is required" });
    let receipt: ReceiptFields;
    let manifest: ManifestV1 | undefined;
    if (b.manifest !== undefined) {
      const v = validateManifest(b.manifest);
      if (!v.ok) return send(res, 400, { error: "invalid manifest", errors: v.errors });
      manifest = v.manifest;
      receipt = { runId: manifest.runId, manifestHash: hashManifest(manifest), agent: manifest.agent, principal: manifest.principal, schemaVersion: manifest.receiptVersion };
      if (b.receipt && JSON.stringify(b.receipt) !== JSON.stringify(receipt)) return send(res, 400, { error: "receipt does not match the manifest" });
    } else if (b.receipt) {
      receipt = b.receipt;
    } else return send(res, 400, { error: "manifest or receipt is required" });

    let signer: string;
    try {
      signer = (await recoverReceiptSigner(receipt, b.agentSignature, domain)).toLowerCase();
    } catch {
      return send(res, 400, { error: "agentSignature is not a valid signature" });
    }
    if (signer !== receipt.agent && signer !== receipt.principal) {
      return send(res, 400, { error: `agentSignature recovers to ${signer}, not the agent or principal` });
    }

    const receiptUrl = `${base}/receipts/${receipt.runId}`;
    const existing = entries.get(receipt.runId);
    if (existing) {
      if (existing.receipt.manifestHash !== receipt.manifestHash) return send(res, 409, { error: "run_id_conflict", message: "this run id is already registered for a different receipt (manifest hash, agent or principal differ)", runId: receipt.runId });
      if (!!existing.direct !== direct) return send(res, 409, { error: "run_id_conflict", message: `this receipt was already submitted for ${existing.direct ? "direct" : "batch"} anchoring`, runId: receipt.runId });
      // Like the real service: the batch path replays the receipt file; the direct path replays the attestation plus `status`.
      if (existing.direct) return send(res, 200, { ...existing.direct, status: await statusOf(existing) });
      return send(res, 200, await fileOf(existing));
    }
    const entry: Entry = { receipt, agentSignature: b.agentSignature, manifest, stored: b.store === true, anchor: null, stage: "pending" };
    entries.set(receipt.runId, entry);
    if (!direct) return send(res, 202, { runId: receipt.runId, status: entry.stage, receiptUrl });

    // The real direct answer (service/src/app.ts directBody): countersignature and calldata, 202.
    const deadline = Math.floor(Date.now() / 1000) + 1800;
    const service = privateKeyToAccount(options.serviceKey ?? ANVIL_KEYS[ROLE.service]!);
    const serviceSignature = await service.signTypedData(serviceAttestationTypedData(receiptDigest(receipt, domain), BigInt(deadline), domain));
    entry.direct = {
      receipt,
      agentSignature: b.agentSignature,
      deadline,
      serviceSignature,
      registry: options.registry,
      chainId: options.chainId,
      to: options.registry,
      data: encodeFunctionData({ abi: receiptRegistryAbi, functionName: "attest", args: [receipt, b.agentSignature, BigInt(deadline), serviceSignature] }),
      receiptUrl,
    };
    if (options.anchorDirect) {
      // Test convenience: the "caller's transaction" is sent at once, so the receipt is anchored.
      const result = await options.anchorDirect({ receipt, agentSignature: b.agentSignature });
      entry.anchor = result.files[0]!.anchor;
      entry.stage = "hemi-included";
    }
    send(res, 202, entry.direct);
  }

  const server = createServer(async (req, res) => {
    try {
      const path = (req.url ?? "/").split("?")[0]!;
      const body = req.method === "POST" ? await readJson(req) : undefined;
      requests.push({ method: req.method ?? "", path, headers: req.headers, body });
      if (body === Symbol.for("invalid-json")) return send(res, 400, { error: "body is not JSON" });
      if (req.method === "GET" && path === "/health") return send(res, 200, { ok: true, chainId: options.chainId, registry: options.registry });
      if (req.method === "POST" && path === "/attest") return await attest(req, res, body, false);
      if (req.method === "POST" && path === "/attest/direct") return await attest(req, res, body, true);
      const m = /^\/receipts\/(0x[0-9a-fA-F]{64})$/.exec(path);
      if (req.method === "GET" && m) {
        const entry = entries.get(m[1]!.toLowerCase());
        if (!entry) return send(res, 404, { error: `unknown runId ${m[1]}` });
        return send(res, 200, await fileOf(entry));
      }
      send(res, 404, { error: `no route ${req.method} ${path}` });
    } catch (error) {
      send(res, 500, { error: (error as Error).message });
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    url: base,
    requests,
    payments,
    get dropPaid() {
      return dropPaid;
    },
    set dropPaid(value: boolean) {
      dropPaid = value;
    },
    entries,
    async flush() {
      const pending = [...entries.values()].filter((e) => e.anchor === null && e.stage === "pending");
      if (pending.length === 0 || !options.anchor) return undefined;
      const result = await options.anchor(pending.map((e) => ({ receipt: e.receipt, agentSignature: e.agentSignature })));
      pending.forEach((entry, i) => {
        entry.anchor = result.files[i]!.anchor;
        entry.stage = "hemi-included";
      });
      return result;
    },
    setStage(runId, stage) {
      const entry = entries.get(runId.toLowerCase());
      if (!entry) throw new Error(`unknown runId ${runId}`);
      entry.stage = stage;
    },
    async stop() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
