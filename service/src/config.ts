import { getAddress, isAddress, type Address, type Hex } from "viem";
import { HEMI_MAINNET, HEMI_NETWORKS, HEMI_TESTNET } from "@hemi-receipts/sdk";

/**
 * Service configuration, read from the environment once at startup. Every problem is
 * collected and reported together; secrets are never echoed back.
 */
export interface PaymentAsset {
  address: Address;
  transferMethod: "permit2" | "eip3009";
  /** EIP-712 domain of the token, required for EIP-3009. */
  eip712?: { name: string; version: string };
}

export interface Config {
  chainId: number;
  rpcUrls: string[];
  registry: Address;
  registryDeployBlock: bigint;
  servicePrivateKey: Hex;
  relayerPrivateKey: Hex;
  dbPath: string;
  host: string;
  port: number;
  publicBaseUrl?: string;
  batchMaxSize: number;
  batchMaxWaitMs: number;
  hemiConfirmations: number;
  pollIntervalMs: number;
  /** Longest the poller waits between checks of one confirmed batch. */
  pollMaxIntervalMs: number;
  /** How often a btc-final batch is re-read for a void (getBatch only). */
  pollFinalCheckMs: number;
  /** Batches checked per poller tick, at most. Bounds RPC use. */
  pollMaxBatchesPerTick: number;
  /** How long a service signature (batch or direct) is valid, in seconds. 10..3600; 1800 by default. */
  signatureTtlSeconds: number;
  /** Replace an unmined batch tx with higher fees after this long. */
  stuckTxMs: number;
  devFree: boolean;
  facilitatorUrl: string;
  payTo?: Address;
  priceBatch: string;
  priceDirect: string;
  paymentAsset?: PaymentAsset;
  storeManifestsMaxBytes: number;
  /** Bitcoin stages (FINALITY=off disables; the rest are optional overrides for the SDK reader). */
  finality: { enabled: boolean; esploraUrls?: string[]; minerAddresses?: string[]; scanMaxBlocks?: number };
  rpc: { requestsPerSecond: number; burst: number; timeoutMs: number; retryCount: number; retryDelayMs: number };
  logLevel: "debug" | "info" | "warn" | "error" | "silent";
}

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`invalid configuration:\n  - ${problems.join("\n  - ")}`);
    this.name = "ConfigError";
  }
}

/** USDC.e on Hemi, per x402facilitator's shared/hemi.json. */
export const DEFAULT_PAYMENT_ASSETS: Record<number, PaymentAsset> = {
  [HEMI_TESTNET.chainId]: {
    address: "0xD47971C7F5B1067d25cd45d30b2c9eb60de96443",
    transferMethod: "permit2",
  },
  [HEMI_MAINNET.chainId]: {
    address: "0xad11a8BEb98bbf61dbb1aa0F6d6F2ECD87b35afA",
    transferMethod: "eip3009",
    eip712: { name: "Bridged USDC (Stargate)", version: "2" },
  },
};

const MAX_BATCH_COUNT = 65_536;
const CANONICAL_MANIFEST_LIMIT = 1_048_576;
const KEY_RE = /^0x[0-9a-fA-F]{64}$/;
const UINT_RE = /^(0|[1-9][0-9]*)$/;

type Env = Record<string, string | undefined>;

export function loadConfig(env: Env = process.env): Config {
  const problems: string[] = [];
  const get = (name: string): string | undefined => {
    const value = env[name]?.trim();
    return value === "" ? undefined : value;
  };

  const int = (name: string, fallback: number, min: number, max: number): number => {
    const raw = get(name);
    if (raw === undefined) return fallback;
    if (!UINT_RE.test(raw) || Number(raw) < min || Number(raw) > max) {
      problems.push(`${name} must be an integer from ${min} to ${max} (got "${raw}")`);
      return fallback;
    }
    return Number(raw);
  };

  /** Seconds, decimals allowed (tests use sub-second intervals). Returns milliseconds. */
  const seconds = (name: string, fallback: number, min: number, max: number): number => {
    const raw = get(name);
    if (raw === undefined) return Math.round(fallback * 1000);
    const value = Number(raw);
    if (!/^\d+(\.\d+)?$/.test(raw) || !Number.isFinite(value) || value < min || value > max) {
      problems.push(`${name} must be a number of seconds from ${min} to ${max} (got "${raw}")`);
      return Math.round(fallback * 1000);
    }
    return Math.round(value * 1000);
  };

  const key = (name: string, required: boolean): Hex | undefined => {
    const raw = get(name);
    if (raw === undefined) {
      if (required) problems.push(`${name} is required (a 0x-prefixed 32-byte hex private key)`);
      return undefined;
    }
    if (!KEY_RE.test(raw)) {
      problems.push(`${name} must be a 0x-prefixed 32-byte hex private key (value not shown)`);
      return undefined;
    }
    return raw.toLowerCase() as Hex;
  };

  const address = (name: string, required: string | false): Address | undefined => {
    const raw = get(name);
    if (raw === undefined) {
      if (required) problems.push(`${name} is required (${required})`);
      return undefined;
    }
    if (!isAddress(raw, { strict: false }) || /^0x0{40}$/i.test(raw)) {
      problems.push(`${name} must be a non-zero 0x address (got "${raw}")`);
      return undefined;
    }
    return getAddress(raw);
  };

  const baseUnits = (name: string, fallback: string): string => {
    const raw = get(name) ?? fallback;
    if (!UINT_RE.test(raw) || raw === "0") {
      problems.push(`${name} must be a positive integer amount in the asset's base units (got "${raw}")`);
      return fallback;
    }
    return raw;
  };

  const chainId = int("CHAIN_ID", HEMI_TESTNET.chainId, 1, 2 ** 53 - 1);
  const rpcRaw = get("HEMI_RPC_URLS");
  let rpcUrls = rpcRaw
    ? rpcRaw
        .split(",")
        .map((url) => url.trim())
        .filter(Boolean)
    : (HEMI_NETWORKS[chainId]?.rpcUrls ?? []);
  if (rpcUrls.length === 0) problems.push(`HEMI_RPC_URLS is required for chain ${chainId} (no default RPC is known for it)`);
  for (const url of rpcUrls) {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error();
    } catch {
      problems.push(`HEMI_RPC_URLS contains "${url}", which is not an http(s) URL`);
      rpcUrls = [];
    }
  }

  const registry = address("REGISTRY_ADDRESS", "the deployed ReceiptRegistry contract");
  const deployRaw = get("REGISTRY_DEPLOY_BLOCK") ?? "0";
  let registryDeployBlock = 0n;
  if (!UINT_RE.test(deployRaw)) problems.push(`REGISTRY_DEPLOY_BLOCK must be a block number (got "${deployRaw}")`);
  else registryDeployBlock = BigInt(deployRaw);

  const servicePrivateKey = key("SERVICE_PRIVATE_KEY", true);
  const relayerPrivateKey = key("RELAYER_PRIVATE_KEY", false) ?? servicePrivateKey;

  const devFreeRaw = get("DEV_FREE") ?? "0";
  if (!["0", "1", "true", "false"].includes(devFreeRaw)) problems.push(`DEV_FREE must be 1 or 0 (got "${devFreeRaw}")`);
  const devFree = devFreeRaw === "1" || devFreeRaw === "true";

  const facilitatorUrl = get("FACILITATOR_URL") ?? "http://localhost:8080";
  try {
    new URL(facilitatorUrl);
  } catch {
    problems.push(`FACILITATOR_URL must be a URL (got "${facilitatorUrl}")`);
  }
  const payTo = address("PAY_TO", devFree ? false : "the address that receives x402 payments; or set DEV_FREE=1");
  const priceBatch = baseUnits("PRICE_BATCH", "1000");
  const priceDirect = baseUnits("PRICE_DIRECT", "10000");

  // Payment asset: USDC.e on Hemi by default; PAYMENT_ASSET* override (needed for other chains).
  let paymentAsset: PaymentAsset | undefined = DEFAULT_PAYMENT_ASSETS[chainId];
  const assetOverride = address("PAYMENT_ASSET", false);
  const methodRaw = get("PAYMENT_ASSET_TRANSFER_METHOD");
  if (methodRaw !== undefined && methodRaw !== "permit2" && methodRaw !== "eip3009") {
    problems.push(`PAYMENT_ASSET_TRANSFER_METHOD must be permit2 or eip3009 (got "${methodRaw}")`);
  }
  if (assetOverride) {
    const transferMethod = (methodRaw as PaymentAsset["transferMethod"] | undefined) ?? "permit2";
    const name = get("PAYMENT_ASSET_EIP712_NAME");
    const version = get("PAYMENT_ASSET_EIP712_VERSION");
    if (transferMethod === "eip3009" && (!name || !version)) {
      problems.push("PAYMENT_ASSET_EIP712_NAME and PAYMENT_ASSET_EIP712_VERSION are required for an eip3009 PAYMENT_ASSET");
    }
    paymentAsset = { address: assetOverride, transferMethod, ...(name && version ? { eip712: { name, version } } : {}) };
  }
  if (!devFree && !paymentAsset) {
    problems.push(`no default payment asset for chain ${chainId}; set PAYMENT_ASSET (or DEV_FREE=1)`);
  }

  const storeManifestsMaxBytes = int("STORE_MANIFESTS_MAX_BYTES", CANONICAL_MANIFEST_LIMIT, 0, CANONICAL_MANIFEST_LIMIT);

  const pollIntervalMs = seconds("POLL_INTERVAL_SECONDS", 15, 0.05, 3600);
  const publicBaseUrl = get("PUBLIC_BASE_URL")?.replace(/\/+$/, "");
  if (publicBaseUrl) {
    try {
      new URL(publicBaseUrl);
    } catch {
      problems.push(`PUBLIC_BASE_URL must be a URL (got "${publicBaseUrl}")`);
    }
  }

  const finalityRaw = (get("FINALITY") ?? "on").toLowerCase();
  if (!["on", "off", "1", "0", "true", "false"].includes(finalityRaw)) problems.push(`FINALITY must be on or off (got "${finalityRaw}")`);
  const list = (name: string): string[] | undefined => {
    const raw = get(name);
    return raw
      ? raw
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean)
      : undefined;
  };
  const esploraUrls = list("BTC_ESPLORA_URLS");
  for (const url of esploraUrls ?? []) {
    try {
      if (!/^https?:$/.test(new URL(url).protocol)) throw new Error();
    } catch {
      problems.push(`BTC_ESPLORA_URLS contains "${url}", which is not an http(s) URL`);
    }
  }
  const minerAddresses = list("POP_MINER_BTC_ADDRESSES");
  const scanRaw = get("BTC_SCAN_MAX_BLOCKS");
  const scanMaxBlocks = scanRaw === undefined ? undefined : int("BTC_SCAN_MAX_BLOCKS", 0, 1, 100_000);
  const finality = {
    enabled: !["off", "0", "false"].includes(finalityRaw),
    ...(esploraUrls ? { esploraUrls } : {}),
    ...(minerAddresses ? { minerAddresses } : {}),
    ...(scanMaxBlocks !== undefined ? { scanMaxBlocks } : {}),
  };

  const logLevel = (get("LOG_LEVEL") ?? "info") as Config["logLevel"];
  if (!["debug", "info", "warn", "error", "silent"].includes(logLevel)) {
    problems.push(`LOG_LEVEL must be debug, info, warn, error or silent (got "${logLevel}")`);
  }

  const config = {
    chainId,
    rpcUrls,
    registry: registry!,
    registryDeployBlock,
    servicePrivateKey: servicePrivateKey!,
    relayerPrivateKey: relayerPrivateKey!,
    dbPath: get("DB_PATH") ?? "./data/receipts.sqlite",
    host: get("HOST") ?? "0.0.0.0",
    port: int("PORT", 8787, 0, 65_535),
    ...(publicBaseUrl ? { publicBaseUrl } : {}),
    batchMaxSize: int("BATCH_MAX_SIZE", 64, 1, MAX_BATCH_COUNT),
    batchMaxWaitMs: seconds("BATCH_MAX_WAIT_SECONDS", 60, 0, 86_400),
    hemiConfirmations: int("HEMI_CONFIRMATIONS", 10, 1, 100_000),
    pollIntervalMs,
    pollMaxIntervalMs: seconds("POLL_MAX_INTERVAL_SECONDS", 600, 0.05, 86_400),
    pollFinalCheckMs: seconds("POLL_FINAL_CHECK_SECONDS", 3600, 0.05, 7 * 86_400),
    pollMaxBatchesPerTick: int("POLL_MAX_BATCHES_PER_TICK", 20, 1, 1000),
    signatureTtlSeconds: int("SIGNATURE_TTL_SECONDS", 1800, 10, 3600),
    stuckTxMs: seconds("STUCK_TX_SECONDS", 180, 0.05, 86_400),
    devFree,
    facilitatorUrl,
    ...(payTo ? { payTo } : {}),
    priceBatch,
    priceDirect,
    ...(paymentAsset ? { paymentAsset } : {}),
    storeManifestsMaxBytes,
    finality,
    rpc: {
      requestsPerSecond: int("RPC_REQUESTS_PER_SECOND", 4, 1, 10_000),
      burst: int("RPC_BURST", 8, 1, 10_000),
      timeoutMs: int("RPC_TIMEOUT_MS", 15_000, 100, 120_000),
      retryCount: int("RPC_RETRY_COUNT", 6, 0, 20),
      retryDelayMs: int("RPC_RETRY_DELAY_MS", 250, 1, 60_000),
    },
    logLevel,
  } satisfies Config;

  if (problems.length > 0) throw new ConfigError(problems);
  return config;
}
