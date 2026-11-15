import type { Address } from "viem";
import { DEPLOYMENTS, explorerTxUrl, HEMI_NETWORKS, verify, VERIFY_CHECKS, type VerifyCheck } from "@hemi-receipts/sdk";
import { parse } from "../args.js";
import { BTC_OPTIONS, BTC_USAGE, describeBtc, finalityFrom } from "../btc.js";
import { ADDRESS_RE, EXIT, json, readJson, UsageError, type Io } from "../io.js";

export const usage = `receipts verify <receipt.json> [--rpc URL]... [--registry ADDR] [--manifest FILE] [--confirmations N]
                [--esplora URL]... [--pop-miner ADDR]... [--btc-scan N] [--no-btc] [--json]

Checks a receipt file against the chain alone; the receipts service is never contacted.
The registry you trust comes from --registry or the SDK's known deployment for the file's
chain, never from the file. RPCs default to the Hemi network's public RPCs.
Exit status: 0 valid, 1 invalid, 2 usage error or the chain could not be read. The Bitcoin
stage is reported but never changes validity.

${BTC_USAGE}`;

const DESCRIPTIONS: Record<VerifyCheck, string> = {
  file: "well-formed receipt file",
  registry: "file's registry is the one you trust",
  chainId: "RPC serves the receipt's chain",
  manifest: "manifest re-hashes to manifestHash and matches the receipt",
  agentSignature: "EIP-712 signature by the agent or principal",
  anchor: "receipt is anchored",
  merkleProof: "Merkle proof reaches the anchor's root (local)",
  batch: "batch exists, is live, root and schema version match",
  onchainProof: "registry.verifyReceipt is true",
  anchorTx: "anchoring tx found in the BatchAttested log",
  status: "finality stage read",
};

export async function verifyCommand(argv: string[], io: Io): Promise<number> {
  const { values, positionals } = parse(argv, {
    rpc: { type: "string", multiple: true },
    registry: { type: "string" },
    manifest: { type: "string" },
    confirmations: { type: "string" },
    json: { type: "boolean" },
    ...BTC_OPTIONS,
  });
  if (positionals.length !== 1) throw new UsageError("give exactly one receipt file");
  const path = positionals[0]!;
  const file = await readJson(path, io);
  const chainId = typeof file === "object" && file !== null ? (file as { chainId?: unknown }).chainId : undefined;

  let registry: Address;
  let registrySource: string;
  if (values.registry !== undefined) {
    if (!ADDRESS_RE.test(values.registry)) throw new UsageError("--registry must be a 20-byte 0x address");
    registry = values.registry as Address;
    registrySource = "--registry";
  } else {
    if (typeof chainId !== "number") throw new UsageError(`${path} has no numeric chainId, so there is no default registry; pass --registry`);
    const known = DEPLOYMENTS[chainId];
    if (!known) throw new UsageError(`no known ReceiptRegistry deployment for chain ${chainId}; pass --registry with the registry address you trust`);
    registry = known.registry;
    registrySource = `known deployment on chain ${chainId}`;
  }
  const rpcUrls = values.rpc?.length ? values.rpc : typeof chainId === "number" ? HEMI_NETWORKS[chainId]?.rpcUrls : undefined;
  if (!rpcUrls?.length) throw new UsageError(`no default RPC for chain ${String(chainId)}; pass --rpc URL`);
  let confirmations: number | undefined;
  if (values.confirmations !== undefined) {
    confirmations = Number(values.confirmations);
    if (!Number.isSafeInteger(confirmations) || confirmations < 1) throw new UsageError("--confirmations must be a positive integer");
  }
  const manifest = values.manifest ? await readJson(values.manifest, io) : undefined;

  const finality = finalityFrom(values, typeof chainId === "number" ? chainId : 0);
  const result = await verify(file, { registry, rpcUrls, manifest, confirmations, finality });

  if (values.json) {
    io.out(json({ file: path, registry, registrySource, rpcUrls, ...result }));
  } else {
    const runId = (file as { receipt?: { runId?: string } })?.receipt?.runId ?? "?";
    const network = typeof chainId === "number" ? (HEMI_NETWORKS[chainId]?.name ?? `chain ${chainId}`) : "unknown chain";
    const lines = [`receipt ${runId}`, `  ${network}, registry ${registry} (${registrySource})`];
    for (const check of VERIFY_CHECKS) lines.push(`  ${result.checks[check].padEnd(5)} ${check.padEnd(15)}${DESCRIPTIONS[check]}`);
    if (result.signer) {
      const how = result.signer.method === "ecdsa" ? "ECDSA" : "EIP-1271 contract wallet";
      const whose = result.signer.role === "principal" ? ", not by the agent" : "";
      lines.push(`  signed by the ${result.signer.role} ${result.signer.address} (${how})${whose}`);
    }
    const anchor = (file as { anchor?: { batchId?: number } } | null)?.anchor;
    if (result.valid) {
      const link = result.batchTx ? explorerTxUrl(chainId as number, result.batchTx) : undefined;
      lines.push(`VALID: in batch ${anchor?.batchId}, anchored by tx ${result.batchTx}${link ? ` (${link})` : ""}`);
      if (result.status) {
        const h = result.status.hemi;
        lines.push(`  stage ${result.status.stage}${result.status.estimated ? " (estimated)" : ""}${h ? `, ${h.confirmations} Hemi confirmations${h.safeBlock !== undefined ? `, safe head ${h.safeBlock}` : ""}` : ""}`);
        const btc = describeBtc(result.status, chainId as number);
        if (btc) lines.push(`  bitcoin ${btc}`);
        for (const note of result.status.notes ?? []) lines.push(`  note ${note}`);
      }
    } else {
      lines.push(result.incomplete ? "UNDETERMINED: the chain could not be read" : "INVALID");
      for (const reason of result.reasons) lines.push(`  - ${reason}`);
      if (result.status) lines.push(`  stage ${result.status.stage}`);
    }
    io.out(lines.join("\n"));
  }
  if (result.valid) return EXIT.ok;
  return result.incomplete ? EXIT.usage : EXIT.failed;
}
