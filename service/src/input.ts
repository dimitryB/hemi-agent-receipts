import {
  BaseError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
  hexToBigInt,
  hexToNumber,
  recoverAddress,
  size,
  slice,
  type Address,
  type Hex,
} from "viem";
import {
  canonicalize,
  leafHash,
  ManifestError,
  normalizeManifest,
  receiptDigest,
  receiptFromManifest,
  RECEIPT_VERSION,
  ZERO_ADDRESS,
  ZERO_BYTES32,
  type ManifestV1,
  type ReceiptFields,
} from "@hemi-receipts/sdk";
import type { ChainContext } from "./chain.js";
import { withTimeout } from "./chain.js";

/** An error with an HTTP status and a stable machine-readable code. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/** A validated, normalized POST /attest body. */
export interface AttestInput {
  receipt: ReceiptFields;
  leaf: Hex;
  agentSignature: Hex;
  manifest?: ManifestV1;
  /** RFC 8785 form of `manifest`; what gets stored when `store` is true. */
  manifestCanonical?: string;
  store: boolean;
}

/** Schema versions this service can batch. */
export const SUPPORTED_SCHEMA_VERSIONS = new Set<number>([RECEIPT_VERSION]);

const BODY_FIELDS = new Set(["manifest", "receipt", "agentSignature", "store"]);
const RECEIPT_FIELDS = ["runId", "manifestHash", "agent", "principal", "schemaVersion"] as const;
const BYTES32_ANY = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS_ANY = /^0x[0-9a-fA-F]{40}$/;
const HEX_ANY = /^0x([0-9a-fA-F]{2})+$/;
/** Generous bound for contract-wallet signatures; an EOA signature is 65 bytes. */
const MAX_SIGNATURE_BYTES = 4096;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validates the five receipt fields a client may send instead of a manifest. */
export function parseReceiptFields(input: unknown): ReceiptFields {
  if (!isPlainObject(input)) throw new HttpError(400, "invalid_receipt", "receipt must be an object with runId, manifestHash, agent, principal, schemaVersion");
  const errors: string[] = [];
  for (const key of Object.keys(input)) {
    if (!(RECEIPT_FIELDS as readonly string[]).includes(key)) errors.push(`${key}: unknown field`);
  }
  const { runId, manifestHash, agent, principal, schemaVersion } = input;
  if (typeof runId !== "string" || !BYTES32_ANY.test(runId)) errors.push("runId: must be 0x-prefixed 32-byte hex");
  else if (runId.toLowerCase() === ZERO_BYTES32) errors.push("runId: must not be zero");
  if (typeof manifestHash !== "string" || !BYTES32_ANY.test(manifestHash)) errors.push("manifestHash: must be 0x-prefixed 32-byte hex");
  else if (manifestHash.toLowerCase() === ZERO_BYTES32) errors.push("manifestHash: must not be zero");
  for (const [name, value] of [
    ["agent", agent],
    ["principal", principal],
  ] as const) {
    if (typeof value !== "string" || !ADDRESS_ANY.test(value)) errors.push(`${name}: must be a 0x-prefixed 20-byte address`);
    else if (value.toLowerCase() === ZERO_ADDRESS) errors.push(`${name}: must not be the zero address`);
  }
  if (typeof schemaVersion !== "number" || !Number.isSafeInteger(schemaVersion)) errors.push("schemaVersion: must be an integer");
  else if (!SUPPORTED_SCHEMA_VERSIONS.has(schemaVersion)) errors.push(`schemaVersion: ${schemaVersion} is not supported by this service`);
  if (errors.length) throw new HttpError(400, "invalid_receipt", `invalid receipt: ${errors.join("; ")}`, { errors });
  return {
    runId: (runId as string).toLowerCase() as Hex,
    manifestHash: (manifestHash as string).toLowerCase() as Hex,
    agent: (agent as string).toLowerCase() as Address,
    principal: (principal as string).toLowerCase() as Address,
    schemaVersion: schemaVersion as number,
  };
}

/**
 * Parses `{ manifest?, receipt?, agentSignature, store? }`. A client may send only the five
 * receipt fields (privacy); if it sends both, they must agree.
 */
export function parseAttestBody(body: unknown, options: { storeMaxBytes: number }): AttestInput {
  if (!isPlainObject(body)) throw new HttpError(400, "invalid_request", "request body must be a JSON object");
  const unknown = Object.keys(body).filter((key) => !BODY_FIELDS.has(key));
  if (unknown.length) throw new HttpError(400, "invalid_request", `unknown field(s): ${unknown.join(", ")}`);
  if (body.manifest === undefined && body.receipt === undefined) {
    throw new HttpError(400, "invalid_request", "send a manifest, or the five receipt fields as receipt, or both");
  }
  if (body.store !== undefined && typeof body.store !== "boolean") throw new HttpError(400, "invalid_request", "store must be a boolean");
  const store = body.store === true;

  const signature = body.agentSignature;
  if (typeof signature !== "string" || !HEX_ANY.test(signature) || size(signature as Hex) > MAX_SIGNATURE_BYTES) {
    throw new HttpError(400, "invalid_agent_signature", "agentSignature must be 0x-prefixed hex (65 bytes for an EOA)");
  }
  const agentSignature = signature.toLowerCase() as Hex;

  let manifest: ManifestV1 | undefined;
  let fromManifest: ReceiptFields | undefined;
  if (body.manifest !== undefined) {
    try {
      manifest = normalizeManifest(body.manifest);
    } catch (error) {
      if (error instanceof ManifestError) {
        throw new HttpError(400, "invalid_manifest", error.message, { errors: error.errors });
      }
      throw new HttpError(400, "invalid_manifest", (error as Error).message);
    }
    fromManifest = receiptFromManifest(manifest);
    if (!SUPPORTED_SCHEMA_VERSIONS.has(fromManifest.schemaVersion)) {
      throw new HttpError(400, "invalid_manifest", `receiptVersion ${fromManifest.schemaVersion} is not supported by this service`);
    }
  }

  let receipt: ReceiptFields;
  if (body.receipt !== undefined) {
    receipt = parseReceiptFields(body.receipt);
    if (fromManifest) {
      const differs = RECEIPT_FIELDS.filter((key) => String(receipt[key]) !== String(fromManifest![key]));
      if (differs.length) {
        throw new HttpError(400, "manifest_receipt_mismatch", `receipt does not match the manifest in: ${differs.join(", ")}`, {
          fields: differs,
          expected: fromManifest,
        });
      }
    }
  } else {
    receipt = fromManifest!;
  }

  let manifestCanonical: string | undefined;
  if (manifest) {
    manifestCanonical = canonicalize(manifest);
    if (store) {
      const bytes = Buffer.byteLength(manifestCanonical, "utf8");
      if (options.storeMaxBytes === 0) {
        throw new HttpError(400, "store_disabled", "this service does not store manifests (STORE_MANIFESTS_MAX_BYTES=0)");
      }
      if (bytes > options.storeMaxBytes) {
        throw new HttpError(413, "manifest_too_large_to_store", `the canonical manifest is ${bytes} bytes; this service stores at most ${options.storeMaxBytes}`);
      }
    }
  } else if (store) {
    throw new HttpError(400, "invalid_request", "store: true needs the manifest");
  }

  return {
    receipt,
    leaf: leafHash(receipt),
    agentSignature,
    ...(manifest ? { manifest, manifestCanonical: manifestCanonical! } : {}),
    store,
  };
}

const SECP256K1_HALF_N = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;
const ERC1271_MAGIC = "0x1626ba7e";
const erc1271Abi = [
  {
    type: "function",
    name: "isValidSignature",
    stateMutability: "view",
    inputs: [
      { name: "hash", type: "bytes32" },
      { name: "signature", type: "bytes" },
    ],
    outputs: [{ name: "", type: "bytes4" }],
  },
] as const;

/**
 * ECDSA recovery the way OpenZeppelin's ECDSA.tryRecover accepts it: exactly 65 bytes,
 * v ∈ {27, 28}, low s. Anything else is not a valid EOA signature on chain either.
 */
export async function recoverStrict(digest: Hex, signature: Hex): Promise<Address | undefined> {
  if (size(signature) !== 65) return undefined;
  const s = hexToBigInt(slice(signature, 32, 64));
  const v = hexToNumber(slice(signature, 64, 65));
  if (v !== 27 && v !== 28) return undefined;
  if (s > SECP256K1_HALF_N || s === 0n) return undefined;
  try {
    return (await recoverAddress({ hash: digest, signature })).toLowerCase() as Address;
  } catch {
    return undefined;
  }
}

/** Non-blocking token bucket: `tryTake()` answers immediately. */
export class Limiter {
  private tokens: number;
  private last = Date.now();
  constructor(
    private readonly ratePerSecond: number,
    private readonly capacity: number,
  ) {
    this.tokens = capacity;
  }
  tryTake(): boolean {
    const now = Date.now();
    this.tokens = Math.min(this.capacity, this.tokens + ((now - this.last) / 1000) * this.ratePerSecond);
    this.last = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

/**
 * Which accounts have code, remembered for a while. A contract wallet stays one, and an
 * EIP-7702 delegation rarely changes within minutes, so the lookup need not repeat per request.
 */
export class CodeCache {
  private entries = new Map<Address, { hasCode: boolean; at: number }>();
  constructor(
    private readonly ttlMs = 10 * 60_000,
    private readonly maxEntries = 10_000,
  ) {}

  /** The remembered answer, or undefined when unknown or expired. */
  get(address: Address): boolean | undefined {
    const hit = this.entries.get(address);
    if (!hit) return undefined;
    if (Date.now() - hit.at >= this.ttlMs) {
      this.entries.delete(address);
      return undefined;
    }
    return hit.hasCode;
  }

  /** Reads the account's code through the RPC and remembers the answer. Throws when the RPC does not answer. */
  async lookup(ctx: ChainContext, address: Address): Promise<boolean> {
    const code = await withTimeout(ctx.client.getCode({ address }), 10_000);
    const hasCode = Boolean(code && code !== "0x");
    if (this.entries.size >= this.maxEntries) this.entries.delete(this.entries.keys().next().value!);
    this.entries.set(address, { hasCode, at: Date.now() });
    return hasCode;
  }
}

/**
 * The agent's EIP-712 signature over the Receipt must come from `agent` or `principal`, for
 * this registry's domain, and it must be one the registry would accept: an account without
 * code is checked with ECDSA, an account with code (a contract wallet, or an EIP-7702-delegated
 * EOA) only through EIP-1271 `isValidSignature`, exactly as the contract does. The code lookups
 * and the EIP-1271 calls go through the RPC, rate limited so bad signatures cannot drain the
 * RPC budget the batcher needs, and which accounts have code is cached.
 *
 * An ECDSA match whose account cannot be looked up right now (rate limited, or the RPC does not
 * answer) is accepted, as every ECDSA match was before the code check existed: the key did
 * sign, and at worst a direct-path transaction for an EIP-7702 account fails on chain.
 */
export async function verifyAgentSignature(
  ctx: ChainContext,
  input: AttestInput,
  limiter: Limiter,
  codes: CodeCache,
): Promise<{ signer: Address; method: "ecdsa" | "eip1271" }> {
  const digest = receiptDigest(input.receipt, ctx.domain);
  const candidates = [...new Set([input.receipt.agent, input.receipt.principal])] as Address[];
  const recovered = await recoverStrict(digest, input.agentSignature);
  const byKey = recovered && candidates.includes(recovered) ? recovered : undefined;

  if (byKey) {
    const ecdsa = { signer: byKey, method: "ecdsa" as const };
    let hasCode = codes.get(byKey);
    if (hasCode === undefined) {
      if (!limiter.tryTake()) return ecdsa;
      try {
        hasCode = await codes.lookup(ctx, byKey);
      } catch {
        return ecdsa;
      }
    }
    if (!hasCode) return ecdsa;
    // The key signed, but its account has code: on chain only EIP-1271 counts, below.
  }

  if (!limiter.tryTake()) {
    throw new HttpError(503, "signature_check_busy", "contract-wallet signature checks are rate limited; retry shortly");
  }
  try {
    for (const candidate of candidates) {
      const hasCode = codes.get(candidate) ?? (await codes.lookup(ctx, candidate));
      if (!hasCode) {
        if (candidate === byKey) return { signer: byKey, method: "ecdsa" };
        continue;
      }
      try {
        const answer = await withTimeout(
          ctx.client.readContract({ address: candidate, abi: erc1271Abi, functionName: "isValidSignature", args: [digest, input.agentSignature] }),
          10_000,
        );
        if (answer.toLowerCase() === ERC1271_MAGIC) return { signer: candidate, method: "eip1271" };
      } catch (error) {
        // A reverting wallet means "no", exactly as SignatureChecker treats it.
        if (!isRevert(error)) throw error;
      }
    }
  } catch (error) {
    throw new HttpError(503, "signature_check_unavailable", `could not check the contract-wallet signature: ${(error as Error).message.split("\n")[0]}`);
  }
  throw new HttpError(
    400,
    "invalid_agent_signature",
    byKey
      ? `agentSignature is an ECDSA signature by ${byKey}, but that account has code, so the registry checks it only through EIP-1271, which did not approve it`
      : "agentSignature is not a valid EIP-712 Receipt signature by the agent or the principal for this registry",
  );
}

/** True when the call reached the contract and it said no (revert, or no data), not a transport failure. */
function isRevert(error: unknown): boolean {
  if (!(error instanceof BaseError)) return false;
  return Boolean(error.walk((e) => e instanceof ContractFunctionRevertedError || e instanceof ContractFunctionZeroDataError));
}
