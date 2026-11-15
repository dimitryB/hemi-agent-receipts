import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import type { Address, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  ConflictError,
  getServiceInfo,
  ManifestError,
  normalizeManifest,
  PaymentRequiredError,
  describePaymentRequired,
  receiptFromManifest,
  registryDomain,
  ServiceError,
  signReceipt,
  STAGES,
  submit,
  submitDirect,
  ValidationError,
  waitForReceipt,
  WaitError,
  type DirectAttestation,
  type FetchLike,
  type ManifestV1,
  type ReceiptFile,
  type ServiceReceipt,
  type Stage,
  type SubmitResult,
} from "@hemi-receipts/sdk";
import { parse } from "../args.js";
import { ADDRESS_RE, EXIT, Failure, json, readJson, serviceUrl, UsageError, type Io } from "../io.js";
import { createPayingFetch, DEFAULT_MAX_PAYMENT, parseKey } from "../x402.js";

export const usage = `receipts attest <manifest.json...> [--service URL] [--key-env NAME] [--chain-id N] [--registry ADDR]
                [--direct] [--store] [--wait[=STAGE]] [--timeout SEC] [--interval SEC] [--out DIR] [--json]
                [--approve-permit2]

Normalizes and validates each manifest, signs its Receipt (EIP-712) with the key in the
environment variable --key-env (default AGENT_PRIVATE_KEY; the key's address must be the
manifest's agent or principal) and submits it to the service (--service, RECEIPTS_SERVICE_URL,
default http://localhost:8787). Prints one line per manifest: "<runId> <status>".

  --chain-id, --registry  EIP-712 domain; default: the service's GET /health
  --direct                anchor each receipt in its own transaction (POST /attest/direct): the
                          service countersigns, and the CLI writes <runId>.attest.json (to, data,
                          deadline) to --out for you to send; --wait then waits for your tx
  --store                 ask the service to keep the manifest
  --wait[=STAGE]          poll until STAGE (default hemi-included; one of ${STAGES.join(", ")})
                          and write <runId>.receipt.json (with the local manifest) to --out
  --timeout SEC           the most --wait may take in total, across every receipt (default 600);
                          a receipt not there in time reports its last stage, and the exit is 1
  --interval SEC          seconds between status reads while waiting (default 5)
  --out DIR               where --wait writes receipt files (default .)
  --json                  print a JSON array instead of lines

Payment: on HTTP 402, if X402_PRIVATE_KEY is set the CLI pays with x402 and retries, up to
X402_MAX_AMOUNT base units per payment (default ${DEFAULT_MAX_PAYMENT}); X402_RPC_URL overrides the RPC
used for the Permit2 allowance check, and --approve-permit2 lets it send the one-time approval.
Without X402_PRIVATE_KEY it stops and shows the price.`;

interface Outcome {
  file: string;
  runId?: Hex;
  status?: string;
  httpStatus?: number;
  created?: boolean;
  receiptUrl?: string;
  receiptFile?: string;
  /** --direct: the signed calldata to send yourself (<runId>.attest.json). */
  attestFile?: string;
  error?: string;
}

function preprocess(argv: string[]): string[] {
  // `--wait` alone means --wait=hemi-included; parseArgs needs a value for string options.
  return argv.map((a) => (a === "--wait" ? "--wait=hemi-included" : a));
}

export async function attest(argv: string[], io: Io): Promise<number> {
  const { values, positionals } = parse(preprocess(argv), {
    service: { type: "string" },
    "key-env": { type: "string", default: "AGENT_PRIVATE_KEY" },
    "chain-id": { type: "string" },
    registry: { type: "string" },
    direct: { type: "boolean" },
    store: { type: "boolean" },
    wait: { type: "string" },
    timeout: { type: "string", default: "600" },
    interval: { type: "string", default: "5" },
    out: { type: "string", default: "." },
    json: { type: "boolean" },
    "approve-permit2": { type: "boolean" },
  });
  if (positionals.length === 0) throw new UsageError("give at least one manifest file");
  const url = serviceUrl(values.service, io);
  const keyEnv = values["key-env"]!;
  const key = parseKey(io.env[keyEnv], `${keyEnv} (the agent's or principal's key; see --key-env)`);
  const signer = privateKeyToAccount(key);
  const until = values.wait as Stage | undefined;
  if (until !== undefined && !(STAGES as readonly string[]).includes(until)) throw new UsageError(`--wait stage must be one of ${STAGES.join(", ")}`);
  const timeoutMs = seconds(values.timeout!, "--timeout");
  const intervalMs = seconds(values.interval!, "--interval");
  if (values.registry !== undefined && !ADDRESS_RE.test(values.registry)) throw new UsageError("--registry must be a 20-byte 0x address");
  let chainId = values["chain-id"] !== undefined ? Number(values["chain-id"]) : undefined;
  if (chainId !== undefined && (!Number.isSafeInteger(chainId) || chainId <= 0)) throw new UsageError("--chain-id must be a positive integer");
  const maxAmount = parseMax(io.env.X402_MAX_AMOUNT);

  // Read and check every manifest before signing anything; bad ones are reported, good ones still go.
  const manifests: { file: string; manifest?: ManifestV1; error?: string }[] = [];
  for (const file of positionals) {
    try {
      const manifest = normalizeManifest(await readJson(file, io));
      const me = signer.address.toLowerCase();
      if (me !== manifest.agent && me !== manifest.principal) {
        manifests.push({ file, error: `${keyEnv} is ${signer.address}, which is neither the agent ${manifest.agent} nor the principal ${manifest.principal}` });
      } else manifests.push({ file, manifest });
    } catch (error) {
      if (error instanceof ManifestError) manifests.push({ file, error: error.message });
      else if (error instanceof UsageError) manifests.push({ file, error: error.message });
      else throw error;
    }
  }

  let registry = values.registry as Address | undefined;
  if (chainId === undefined || registry === undefined) {
    const health = await getServiceInfo(url, { fetch: io.fetch }).catch((error: unknown) => {
      throw new UsageError(`cannot read the EIP-712 domain from ${url}/health (${(error as Error).message}); pass --chain-id and --registry`);
    });
    chainId ??= health.chainId;
    registry ??= health.registry as Address;
  }
  const domain = registryDomain(chainId, registry.toLowerCase() as Address);

  let fetcher: FetchLike = io.fetch;
  let paying = false;
  const outcomes: Outcome[] = [];
  const submitted: { outcome: Outcome; manifest: ManifestV1 }[] = [];

  for (const item of manifests) {
    const outcome: Outcome = { file: item.file };
    outcomes.push(outcome);
    if (!item.manifest) {
      outcome.error = item.error;
      continue;
    }
    const manifest = item.manifest;
    outcome.runId = manifest.runId;
    const agentSignature = await signReceipt(signer, receiptFromManifest(manifest), domain);
    const send = (f: FetchLike) =>
      (values.direct ? submitDirect : submit)(url, { manifest, agentSignature, store: values.store ? true : undefined }, { fetch: f });
    try {
      let result: SubmitResult;
      try {
        result = await send(fetcher);
      } catch (error) {
        if (!(error instanceof PaymentRequiredError) || paying) throw error;
        const payKey = io.env.X402_PRIVATE_KEY;
        if (!payKey) throw new PaymentFailure(`payment required: ${describePaymentRequired(error.paymentRequired)}. Set X402_PRIVATE_KEY to pay with x402.`);
        fetcher = createPayingFetch({
          privateKey: parseKey(payKey, "X402_PRIVATE_KEY"),
          accepts: error.accepts,
          maxAmount,
          approvePermit2: values["approve-permit2"] === true,
          rpcUrl: io.env.X402_RPC_URL,
          baseFetch: io.fetch,
          log: (line) => io.err(line),
        });
        paying = true;
        result = await send(fetcher);
      }
      outcome.httpStatus = result.httpStatus;
      outcome.created = result.created;
      outcome.status = result.stage;
      outcome.receiptUrl = result.receiptUrl;
      if (result.direct) {
        outcome.attestFile = await writeAttestFile(result.direct, result.receiptUrl, resolve(io.cwd, values.out!));
        if (!values.json) {
          io.err(`${manifest.runId}: wrote ${outcome.attestFile}; send its calldata to ${result.direct.to} before ${new Date(result.direct.deadline * 1000).toISOString()} (e.g. cast send <to> <data>)`);
        }
      }
      submitted.push({ outcome, manifest });
      if (!until && !values.json) io.out(`${manifest.runId} ${result.stage}${result.created ? "" : " (already submitted)"}`);
    } catch (error) {
      const failure = paymentProblem(error, paying, manifest.runId);
      outcome.error = failure ? failure.message : describe(error, manifest.runId);
      // A payment problem repeats for every manifest: stop instead of trying the rest.
      if (failure) return report(outcomes, io, values.json === true);
    }
  }

  if (until) {
    // One deadline for all of them: --timeout is the most the whole wait may take, not per receipt.
    const deadline = Date.now() + timeoutMs;
    for (const { outcome, manifest } of submitted) {
      try {
        const final = await waitForReceipt(url, manifest.runId, { until, timeoutMs: Math.max(0, deadline - Date.now()), intervalMs, fetch: io.fetch });
        outcome.status = final.status.stage;
        outcome.receiptFile = await writeReceiptFile(final, manifest, resolve(io.cwd, values.out!));
        if (!values.json) {
          io.out(`${manifest.runId} ${final.status.stage}`);
          io.err(`wrote ${outcome.receiptFile}`);
        }
      } catch (error) {
        outcome.error = error instanceof WaitError && error.reason === "timeout" ? timedOut(error, manifest.runId, until, timeoutMs, outcome.status) : describe(error, manifest.runId);
        if (error instanceof WaitError && error.last) outcome.status = error.last.status.stage;
      }
    }
  }
  return report(outcomes, io, values.json === true);
}

/** The shared --timeout passed before this receipt reached the stage: say how long it was and where the receipt got to. */
function timedOut(error: WaitError, runId: Hex, until: Stage, timeoutMs: number, submittedStage?: string): string {
  const stage = error.last?.status.stage ?? submittedStage;
  const where = stage ? `still ${stage}` : (/\(([^()]*)\)$/.exec(error.message)?.[1] ?? "no status");
  return `the ${Math.round(timeoutMs / 1000)}s --timeout, shared by every receipt, ran out before ${runId} reached ${until} (${where})`;
}

class PaymentFailure extends Failure {}

/** A 402 we cannot or did not pay, or a failure inside the x402 payment itself. */
function paymentProblem(error: unknown, paying: boolean, runId: string): Failure | undefined {
  if (error instanceof PaymentFailure) return error;
  if (error instanceof Failure) return new PaymentFailure(error.message); // from createPayingFetch
  if (!paying) return undefined;
  const retry = `retry runId ${runId} with the same manifest, because a new runId would pay again`;
  if (error instanceof PaymentRequiredError) return new PaymentFailure(`the service still asks for payment after paying: ${error.message}. If that payment went through, the service holds this receipt: ${retry}`);
  if (error instanceof ServiceError && error.status === 0 && error.cause instanceof Error) {
    return new PaymentFailure(
      `the connection to the service broke while it was taking the payment (${error.cause.message}). The payment may have gone through, and if so the service holds this receipt: ${retry}`,
    );
  }
  return undefined;
}

function report(outcomes: Outcome[], io: Io, asJson: boolean): number {
  if (asJson) io.out(json(outcomes));
  else for (const o of outcomes) if (o.error) io.err(`${o.file}: ${o.error}`);
  return outcomes.some((o) => o.error) ? EXIT.failed : EXIT.ok;
}

function describe(error: unknown, runId: Hex): string {
  // In the service's words: a 409 is not always a reused runId, and for a payment still settling a new runId would pay twice.
  if (error instanceof ConflictError) return `runId ${runId}: ${error.reason ?? "already used with a different manifest"} (409)`;
  if (error instanceof ValidationError) return `rejected by the service (400): ${error.errors.length ? error.errors.join("; ") : error.message}`;
  if (error instanceof WaitError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

async function writeReceiptFile(final: ServiceReceipt, manifest: ManifestV1, dir: string): Promise<string> {
  const { status: _status, ...rest } = final;
  const file: ReceiptFile = { ...rest, manifest };
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${manifest.runId}.receipt.json`);
  await writeFile(path, `${json(file)}\n`);
  return path;
}

/** The direct path's countersignature and calldata, for the caller's own transaction. */
async function writeAttestFile(direct: DirectAttestation, receiptUrl: string | undefined, dir: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${direct.receipt.runId}.attest.json`);
  await writeFile(path, `${json({ ...direct, ...(receiptUrl ? { receiptUrl } : {}) })}\n`);
  return path;
}

function seconds(value: string, flag: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new UsageError(`${flag} must be a positive number of seconds`);
  return Math.round(n * 1000);
}

function parseMax(value: string | undefined): bigint {
  if (value === undefined || value === "") return DEFAULT_MAX_PAYMENT;
  if (!/^\d+$/.test(value)) throw new UsageError("X402_MAX_AMOUNT must be a whole number of base units");
  return BigInt(value);
}
