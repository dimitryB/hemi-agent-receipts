import type { Address, Hex } from "viem";
import type { ManifestV1, ReceiptFile, StatusInfo } from "@hemi-receipts/sdk";
import type { BatchRow, ReceiptRow } from "./store.js";

/** GET /receipts/:runId: a receipt file (docs/SCHEMA.md §2) plus `status` (§7). */
export type ReceiptResponse = ReceiptFile & { status: StatusInfo };

export function pendingStatus(now = Date.now()): StatusInfo {
  return { stage: "pending", estimated: false, checkedAt: Math.floor(now / 1000) };
}

export function statusOf(row: ReceiptRow): StatusInfo {
  if (row.status_json) return JSON.parse(row.status_json) as StatusInfo;
  return pendingStatus(row.updated_at);
}

export function receiptFile(row: ReceiptRow, batch: BatchRow | null, chainId: number, registry: Address): ReceiptResponse {
  const anchored = row.state === "anchored" && batch && batch.state === "mined" && batch.onchain_batch_id !== null && batch.tx_hash && batch.block_number !== null;
  const file: ReceiptResponse = {
    format: "hemi-agent-receipt",
    formatVersion: 1,
    chainId,
    registry,
    receipt: {
      runId: row.run_id,
      manifestHash: row.manifest_hash,
      agent: row.agent,
      principal: row.principal,
      schemaVersion: row.schema_version,
    },
    agentSignature: row.agent_signature,
    anchor: anchored
      ? {
          mode: row.mode,
          batchId: batch.onchain_batch_id!,
          root: batch.root,
          proof: row.proof_json ? (JSON.parse(row.proof_json) as Hex[]) : [],
          txHash: batch.tx_hash!,
          blockNumber: batch.block_number!,
        }
      : null,
    status: statusOf(row),
  };
  if (row.manifest_json) file.manifest = JSON.parse(row.manifest_json) as ManifestV1;
  return file;
}
