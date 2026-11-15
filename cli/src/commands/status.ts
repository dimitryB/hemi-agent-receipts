import type { Address } from "viem";
import { createHemiPublicClient, DEPLOYMENTS, explorerTxUrl, getReceipt, HEMI_NETWORKS, resolveAnchorStatus, type ServiceReceipt, type StatusInfo } from "@hemi-receipts/sdk";
import { parse } from "../args.js";
import { BTC_OPTIONS, BTC_USAGE, describeBtc, finalityFrom } from "../btc.js";
import { ADDRESS_RE, EXIT, json, RUN_ID_RE, serviceUrl, UsageError, type Io } from "../io.js";

export const usage = `receipts status <runId> [--service URL] [--rpc URL]... [--registry ADDR] [--esplora URL]... [--pop-miner ADDR]... [--btc-scan N] [--no-btc] [--json]

Shows where a receipt is on the finality ladder (pending, hemi-included, hemi-confirmed,
btc-published, btc-final; or voided), its Hemi confirmations and safe head, what is known
about Bitcoin finality, and the anchoring transaction. For an anchored receipt the stage is
re-checked locally from the Hemi RPC (--rpc, default the network's RPCs) and Bitcoin: the batch
is read from the registry you trust (--registry, default the SDK's known deployment for the
chain; never the service's word), so a voided batch or a removed anchor shows as voided or
pending. With --no-btc the service's status is shown as it is.

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
  const { values, positionals } = parse(argv, { service: { type: "string" }, json: { type: "boolean" }, rpc: { type: "string", multiple: true }, registry: { type: "string" }, ...BTC_OPTIONS });
  if (positionals.length !== 1 || !RUN_ID_RE.test(positionals[0]!)) throw new UsageError("give one runId (0x followed by 64 hex digits)");
  if (values.registry !== undefined && !ADDRESS_RE.test(values.registry)) throw new UsageError("--registry must be a 20-byte 0x address");
  const r = await getReceipt(serviceUrl(values.service, io), positionals[0]!, { fetch: io.fetch });

  let local: StatusInfo | undefined;
  if (!values["no-btc"] && r.anchor && r.status.stage !== "voided") {
    const finality = finalityFrom(values, r.chainId);
    const rpcUrls = values.rpc?.length ? values.rpc : HEMI_NETWORKS[r.chainId]?.rpcUrls;
    if (!rpcUrls?.length) io.err(`note: no RPC known for chain ${r.chainId}; pass --rpc to check the stage locally`);
    else {
      try {
        const client = createHemiPublicClient({ chainId: r.chainId, rpcUrls, retryCount: 3 });
        // The chain decides, read from a registry the user trusts: the batch, its root, the
        // anchoring transaction and its block, then the stage. Not the service's block height alone.
        const trusted = (values.registry as Address | undefined) ?? DEPLOYMENTS[r.chainId]?.registry;
        const registry = trusted ?? r.registry;
        local = await resolveAnchorStatus({ client, registry, anchor: r.anchor, confirmations: r.status.hemi?.requiredConfirmations, finality });
        const notes = [
          ...(!trusted ? [`no known registry for chain ${r.chainId}: checked against the service's ${r.registry}; pass --registry to use one you trust`] : []),
          ...(trusted && trusted.toLowerCase() !== r.registry.toLowerCase() ? [`the service reports registry ${r.registry}; checked against ${trusted}`] : []),
        ];
        if (notes.length) local = { ...local, notes: [...(local.notes ?? []), ...notes] };
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
