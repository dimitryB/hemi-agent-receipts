import { createHemiPublicClient, explorerTxUrl, getReceipt, HEMI_NETWORKS, resolveStatus, type ServiceReceipt, type StatusInfo } from "@hemi-receipts/sdk";
import { parse } from "../args.js";
import { BTC_OPTIONS, BTC_USAGE, describeBtc, finalityFrom } from "../btc.js";
import { EXIT, json, RUN_ID_RE, serviceUrl, UsageError, type Io } from "../io.js";

export const usage = `receipts status <runId> [--service URL] [--rpc URL]... [--esplora URL]... [--pop-miner ADDR]... [--btc-scan N] [--no-btc] [--json]

Shows where a receipt is on the finality ladder (pending, hemi-included, hemi-confirmed,
btc-published, btc-final; or voided), its Hemi confirmations and safe head, what is known
about Bitcoin finality, and the anchoring transaction. For an anchored receipt the stage is
re-checked locally from the Hemi RPC (--rpc, default the network's RPCs) and Bitcoin; with
--no-btc the service's status is shown as it is.

${BTC_USAGE}`;

const iso = (unix?: number) => (unix === undefined ? undefined : new Date(unix * 1000).toISOString().replace(".000Z", "Z"));

export function statusSummary(r: ServiceReceipt, source: "local" | "service" = "service", serviceStage?: string) {
  const s = r.status;
  return {
    runId: r.receipt.runId,
    stage: s.stage,
    estimated: s.estimated,
    source,
    ...(serviceStage !== undefined ? { serviceStage } : {}),
    hemi: s.hemi ?? null,
    btc: s.btc ?? null,
    anchor: r.anchor,
    explorer: r.anchor ? (explorerTxUrl(r.chainId, r.anchor.txHash) ?? null) : null,
    chainId: r.chainId,
    registry: r.registry,
    checkedAt: s.checkedAt,
    notes: s.notes ?? [],
  };
}

export function formatStatus(r: ServiceReceipt, source: "local" | "service" = "service", serviceStage?: string): string[] {
  const s = r.status;
  const network = HEMI_NETWORKS[r.chainId]?.name ?? `chain ${r.chainId}`;
  const lines: [string, string][] = [
    ["runId", r.receipt.runId],
    ["stage", `${s.stage}${s.estimated ? " (estimated, not verified)" : ""}`],
    ["source", source === "local" ? `checked locally (Hemi RPC + Bitcoin); the service says ${serviceStage}` : "receipts service"],
  ];
  if (s.hemi) {
    const h = s.hemi;
    lines.push([
      "hemi",
      `block ${h.blockNumber} on ${network}, ${h.confirmations} confirmation${h.confirmations === 1 ? "" : "s"} (${h.requiredConfirmations} required)` +
        `${h.safeBlock !== undefined ? `, safe head ${h.safeBlock}` : ""}, head ${h.latestBlock}`,
    ]);
  }
  const btc = describeBtc(s, r.chainId);
  if (btc) lines.push(["bitcoin", btc]);
  else if (s.stage === "hemi-included") lines.push(["bitcoin", "not checked yet (needs hemi-confirmed first)"]);
  if (r.anchor) {
    lines.push(["anchor", `batch ${r.anchor.batchId} (${r.anchor.mode}), block ${r.anchor.blockNumber}`]);
    lines.push(["tx", r.anchor.txHash]);
    const link = explorerTxUrl(r.chainId, r.anchor.txHash);
    if (link) lines.push(["explorer", link]);
  } else if (s.stage !== "voided") {
    lines.push(["anchor", "not anchored yet: waiting for the next batch"]);
  }
  for (const note of s.notes ?? []) lines.push(["note", note]);
  lines.push(["checked", iso(s.checkedAt) ?? "?"]);
  return lines.map(([k, v]) => `${k.padEnd(10)}${v}`);
}

export async function status(argv: string[], io: Io): Promise<number> {
  const { values, positionals } = parse(argv, { service: { type: "string" }, json: { type: "boolean" }, rpc: { type: "string", multiple: true }, ...BTC_OPTIONS });
  if (positionals.length !== 1 || !RUN_ID_RE.test(positionals[0]!)) throw new UsageError("give one runId (0x followed by 64 hex digits)");
  const r = await getReceipt(serviceUrl(values.service, io), positionals[0]!, { fetch: io.fetch });

  let local: StatusInfo | undefined;
  if (!values["no-btc"] && r.anchor && r.status.stage !== "voided") {
    const finality = finalityFrom(values, r.chainId);
    const rpcUrls = values.rpc?.length ? values.rpc : HEMI_NETWORKS[r.chainId]?.rpcUrls;
    if (!rpcUrls?.length) io.err(`note: no RPC known for chain ${r.chainId}; pass --rpc to check the stage locally`);
    else {
      try {
        const client = createHemiPublicClient({ chainId: r.chainId, rpcUrls, retryCount: 3 });
        local = await resolveStatus({ client, blockNumber: BigInt(r.anchor.blockNumber), confirmations: r.status.hemi?.requiredConfirmations, finality });
      } catch (error) {
        io.err(`warning: could not check the stage locally (${error instanceof Error ? error.message.split("\n")[0] : String(error)}); showing the service's status`);
      }
    }
  }
  const shown: ServiceReceipt = local ? { ...r, status: local } : r;
  const source = local ? "local" : "service";
  if (values.json) io.out(json(statusSummary(shown, source, local ? r.status.stage : undefined)));
  else io.out(formatStatus(shown, source, r.status.stage).join("\n"));
  return EXIT.ok;
}
