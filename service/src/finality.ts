import { defaultFinalityReader, unavailableFinality, type FinalityReader } from "@hemi-receipts/sdk";
import type { Config } from "./config.js";

/**
 * The Bitcoin-stage reader: the SDK's `defaultFinalityReader(CHAIN_ID, overrides)` (PoP
 * keystone reconstruction + Esplora; on testnet, where PoP is off, it reports "unavailable"),
 * with BTC_ESPLORA_URLS, POP_MINER_BTC_ADDRESSES and BTC_SCAN_MAX_BLOCKS as overrides.
 * FINALITY=off uses `unavailableFinality`. On a chain the SDK does not know (anvil) the SDK
 * itself returns `unavailableFinality` unless BTC_ESPLORA_URLS is set.
 */
export function finalityReaderFor(config: Config): { reader: FinalityReader; source: string } {
  if (!config.finality.enabled) return { reader: unavailableFinality, source: "off (FINALITY=off)" };
  const { esploraUrls, minerAddresses, scanMaxBlocks } = config.finality;
  const reader = defaultFinalityReader(config.chainId, {
    ...(esploraUrls ? { esploraUrls } : {}),
    ...(minerAddresses ? { minerAddresses } : {}),
    ...(scanMaxBlocks !== undefined ? { scanMaxBlocks } : {}),
  });
  return { reader, source: reader === unavailableFinality ? "unavailable (no Bitcoin finality source for this chain)" : "sdk defaultFinalityReader" };
}

/** Used for a batch's first confirmed check: Bitcoin is looked at from the next poll on. */
export const notCheckedYet: FinalityReader = {
  async read() {
    return { source: "unavailable", detail: "Bitcoin stages are checked from the next poll" };
  },
};
