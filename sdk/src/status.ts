import type { Hex, PublicClient } from "viem";
import { HEMI_NETWORKS } from "./chains.js";
import type { BtcFinality, StatusInfo } from "./types.js";

/**
 * Reads the Bitcoin stages for a Hemi block. finality.ts has the PoP-based implementation
 * (createPopFinalityReader, defaultFinalityReader); unavailableFinality reports "unavailable"
 * rather than guessing.
 */
export interface FinalityReader {
  read(input: {
    blockNumber: bigint;
    blockHash: Hex;
    blockTimestamp: number;
    client: PublicClient;
    /** The caller's latest Hemi block, when it already has one (saves an RPC call). */
    latestBlock?: bigint;
  }): Promise<BtcFinality>;
}

export const unavailableFinality: FinalityReader = {
  async read() {
    return { source: "unavailable", detail: "no Bitcoin finality source configured" };
  },
};

/** Default number of Hemi blocks on top of the anchoring block before `hemi-confirmed`. */
export const DEFAULT_HEMI_CONFIRMATIONS = 10;

/** Confirmations, counting the publication block, for btc-final (Hemi docs; bfgd v1). */
const BTC_FINAL = 9;

async function readSafeHead(client: PublicClient, notes: string[]): Promise<bigint | null> {
  const chainId = client.chain?.id ?? (await client.getChainId());
  // Only Hemi's OP-stack safe head means "batch posted to Ethereum and derived". A local chain's
  // "safe" tag is synthetic (anvil: latest − 32), so there the count rule alone applies.
  if (!HEMI_NETWORKS[chainId]) return null;
  try {
    const safe = await client.getBlock({ blockTag: "safe" });
    if (safe.number === null) throw new Error("no number");
    return safe.number;
  } catch {
    notes.push("the RPC did not serve the safe head; hemi-confirmed uses the confirmation count only");
    return null;
  }
}

/**
 * Status of an anchoring block that is known to be mined.
 *
 *  - pending: the block at that height is no longer `anchorBlockHash` (reorged out).
 *  - hemi-included: mined, but below the confirmation count or above the safe head.
 *  - hemi-confirmed: at least `confirmations` blocks deep AND at or below the OP-stack safe head.
 *  - btc-published / btc-final: only from verified Bitcoin data (finality source "bitcoin" or
 *    "bfg"): a PoP publication, and at least 9 Bitcoin confirmations of it. An estimate never
 *    advances the stage; it only fills btc.estimated* "expected by" times.
 *
 * Costs two RPC calls (three with the safe head) plus what the finality reader needs.
 * `latestBlock` and `safeBlock` may be passed in to share one read across many receipts.
 * `safeBlock`: omitted = read once with eth_getBlockByNumber("safe") on Hemi networks (count
 * rule only on other chains, or if the RPC cannot serve it); null = count rule only.
 * A finality reader that throws leaves the stage at hemi-confirmed with source "unavailable".
 */
export async function resolveStatus(input: {
  client: PublicClient;
  blockNumber: bigint;
  confirmations?: number;
  finality?: FinalityReader;
  latestBlock?: bigint;
  safeBlock?: bigint | null;
  anchorBlockHash?: Hex;
}): Promise<StatusInfo> {
  const required = input.confirmations ?? DEFAULT_HEMI_CONFIRMATIONS;
  const notes: string[] = [];
  const [block, latest, safe] = await Promise.all([
    input.client.getBlock({ blockNumber: input.blockNumber }),
    input.latestBlock !== undefined ? Promise.resolve(input.latestBlock) : input.client.getBlockNumber({ cacheTime: 0 }),
    input.safeBlock !== undefined ? Promise.resolve(input.safeBlock) : readSafeHead(input.client, notes),
  ]);
  const confirmations = latest >= input.blockNumber ? Number(latest - input.blockNumber) + 1 : 0;
  const hemi: NonNullable<StatusInfo["hemi"]> = {
    blockNumber: Number(input.blockNumber),
    blockTimestamp: Number(block.timestamp),
    latestBlock: Number(latest),
    confirmations,
    requiredConfirmations: required,
    ...(safe !== null ? { safeBlock: Number(safe) } : {}),
  };
  const checkedAt = Math.floor(Date.now() / 1000);
  const done = (status: StatusInfo): StatusInfo => (notes.length ? { ...status, notes: [...(status.notes ?? []), ...notes] } : status);

  if (input.anchorBlockHash && block.hash?.toLowerCase() !== input.anchorBlockHash.toLowerCase()) {
    return done({
      stage: "pending",
      estimated: false,
      hemi,
      checkedAt,
      notes: [`anchoring block was reorged out: block ${input.blockNumber} is now ${block.hash}, the anchor was in ${input.anchorBlockHash}`],
    });
  }
  if (confirmations < required) return done({ stage: "hemi-included", estimated: false, hemi, checkedAt });
  if (safe !== null && input.blockNumber > safe) {
    notes.push(`waiting for the safe head: block ${input.blockNumber} is above safe block ${safe}`);
    return done({ stage: "hemi-included", estimated: false, hemi, checkedAt });
  }

  let btc: BtcFinality;
  try {
    btc = await (input.finality ?? unavailableFinality).read({
      blockNumber: input.blockNumber,
      blockHash: block.hash!,
      blockTimestamp: Number(block.timestamp),
      client: input.client,
      latestBlock: latest,
    });
  } catch (error) {
    btc = { source: "unavailable", detail: `Bitcoin finality could not be read: ${error instanceof Error ? error.message : String(error)}` };
  }
  const verified = btc.source === "bitcoin" || btc.source === "bfg";
  if (verified && btc.btcConfirmations !== undefined && btc.btcConfirmations >= BTC_FINAL) {
    return done({ stage: "btc-final", estimated: false, hemi, btc, checkedAt });
  }
  if (verified && btc.publishedAtBtcHeight !== undefined) {
    return done({ stage: "btc-published", estimated: false, hemi, btc, checkedAt });
  }
  return done({ stage: "hemi-confirmed", estimated: false, hemi, btc, checkedAt });
}
