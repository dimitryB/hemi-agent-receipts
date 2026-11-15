import { defaultFinalityReader, unavailableFinality, type FinalityReader, type PopFinalityOptions, type StatusInfo } from "@hemi-receipts/sdk";
import { UsageError } from "./io.js";

/** Options shared by `verify` and `status` for the Bitcoin finality check. */
export const BTC_OPTIONS = {
  esplora: { type: "string", multiple: true },
  "pop-miner": { type: "string", multiple: true },
  "btc-scan": { type: "string" },
  "no-btc": { type: "boolean" },
} as const;

export const BTC_USAGE = `Bitcoin finality (read from Bitcoin through Esplora; defaults per network, see the SDK's defaultFinalityReader):
  --esplora URL        Esplora base URL (repeatable), e.g. https://blockstream.info/api
  --pop-miner ADDR     known PoP miner Bitcoin address to poll (repeatable; replaces the default list)
  --btc-scan N         scan up to N Bitcoin blocks from the keystone's time for PoP txs (0 = off)
  --no-btc             do not check Bitcoin finality`;

const BTC_ADDRESS = /^([13mn2][a-km-zA-HJ-NP-Z1-9]{25,39}|(bc1|tb1|bcrt1)[0-9a-z]{8,87})$/;

export function finalityFrom(
  values: { esplora?: string[]; "pop-miner"?: string[]; "btc-scan"?: string; "no-btc"?: boolean },
  chainId: number,
): FinalityReader {
  if (values["no-btc"]) return unavailableFinality;
  const overrides: Partial<PopFinalityOptions> = {};
  if (values.esplora?.length) {
    for (const url of values.esplora) if (!/^https?:\/\//.test(url)) throw new UsageError(`--esplora must be an http(s) URL, got ${JSON.stringify(url)}`);
    overrides.esploraUrls = values.esplora;
  }
  if (values["pop-miner"]?.length) {
    for (const a of values["pop-miner"]) if (!BTC_ADDRESS.test(a)) throw new UsageError(`--pop-miner must be a Bitcoin address, got ${JSON.stringify(a)}`);
    overrides.minerAddresses = values["pop-miner"];
  }
  if (values["btc-scan"] !== undefined) {
    const n = Number(values["btc-scan"]);
    if (!Number.isSafeInteger(n) || n < 0) throw new UsageError("--btc-scan must be a whole number of Bitcoin blocks");
    overrides.scanMaxBlocks = n;
  }
  return defaultFinalityReader(chainId, overrides);
}

const iso = (unix: number) => new Date(unix * 1000).toISOString().replace(".000Z", "Z");

/** One line describing what is known about Bitcoin finality. */
export function describeBtc(status: StatusInfo, chainId: number): string | undefined {
  const b = status.btc;
  if (!b) return undefined;
  switch (b.source) {
    case "bitcoin":
    case "bfg": {
      const conf = b.btcConfirmations;
      const parts = [
        `published in Bitcoin block ${b.publishedAtBtcHeight}${b.popTxid ? ` by PoP tx ${b.popTxid}` : ""}`,
        b.viaKeystone !== undefined ? `keystone ${b.viaKeystone}${b.inherited ? ` (inherited by covering keystone ${b.coveringKeystone})` : ""}` : undefined,
        conf !== undefined ? `${conf} confirmation${conf === 1 ? "" : "s"} (9 for btc-final${b.superFinal ? "; super-final at 11+" : ""})` : undefined,
        b.source === "bfg" ? "read from a finality source" : undefined,
      ];
      const link = b.popTxid && chainId === 43_111 ? ` https://mempool.space/tx/${b.popTxid}` : "";
      return parts.filter(Boolean).join(", ") + link;
    }
    case "estimate":
      return `not on Bitcoin yet; ESTIMATE${b.estimatedPublishedAt ? `: published by ~${iso(b.estimatedPublishedAt)}` : ""}${b.estimatedFinalAt ? `, final by ~${iso(b.estimatedFinalAt)}` : ""}${b.detail ? ` (${b.detail})` : ""}`;
    default:
      return `unavailable${b.detail ? `: ${b.detail}` : ""}`;
  }
}
