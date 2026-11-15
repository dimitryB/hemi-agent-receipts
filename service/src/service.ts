import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Express } from "express";
import type { FinalityReader } from "@hemi-receipts/sdk";
import { finalityReaderFor } from "./finality.js";
import { createApp } from "./app.js";
import { Batcher, type BatcherFaults } from "./batcher.js";
import { createChainContext, RegistryGate, startupChecks, StartupError, type ChainContext } from "./chain.js";
import type { Config } from "./config.js";
import { migrate, SqliteD1, type D1Database } from "./db.js";
import { CodeCache, Limiter } from "./input.js";
import { createLogger, errorText, type Logger } from "./log.js";
import { createPaywall, paymentOf, type Paywall } from "./payments.js";
import { StatusPoller } from "./poller.js";
import { SETTLEMENT_HOLD_MS, Store } from "./store.js";

/**
 * How long a stop waits for what is in flight. A paid request may be settling, and cutting it off
 * loses the answer while the money still moves. The x402 client allows a settle 90 s and retries a
 * pending one once, so two attempts must fit; docker-compose.yml's stop_grace_period stays above this.
 */
const SHUTDOWN_DRAIN_MS = 185_000;

export interface ServiceOptions {
  /** Bitcoin-stage reader. Default: the SDK's defaultFinalityReader when present (see finality.ts). */
  finality?: FinalityReader;
  log?: Logger;
  /** A D1 binding (or any D1-shaped database). Default: node:sqlite at config.dbPath. */
  db?: D1Database;
  /** Test hooks for crash simulation. */
  faults?: BatcherFaults;
  /** Start the batcher and poller loops (default true). Tests may drive `tick()` by hand. */
  loops?: boolean;
  /** Listen on config.host:config.port (default true). */
  listen?: boolean;
}

export interface RunningService {
  config: Config;
  app: Express;
  db: D1Database;
  store: Store;
  chain: ChainContext;
  batcher: Batcher;
  poller: StatusPoller;
  paywall?: Paywall;
  server?: Server;
  /** http://host:port of the listening server. */
  url?: string;
  stop(): Promise<void>;
}

/**
 * Opens the database, runs migrations, checks the chain (chain id, registry code,
 * serviceSigner), binds the database to that chain + registry, then serves HTTP and starts
 * the batcher and poller. Throws StartupError with a clear message when a check fails.
 */
export async function startService(config: Config, options: ServiceOptions = {}): Promise<RunningService> {
  const log = options.log ?? createLogger(config.logLevel);
  const ownDb = options.db ? undefined : new SqliteD1(config.dbPath);
  const db = options.db ?? ownDb!;
  try {
    await migrate(db);
    const store = new Store(db);
    const chain = createChainContext(config);
    const { latestBlock } = await startupChecks(chain, config, log);
    await bindDatabase(store, config);
    await holdInterruptedSettlements(store, log);

    const batcher = new Batcher({ store, chain, config, log, ...(options.faults ? { faults: options.faults } : {}) });
    const finality = options.finality ? { reader: options.finality, source: "provided by the caller" } : finalityReaderFor(config);
    const poller = new StatusPoller({ store, chain, config, log, finality: finality.reader });
    const paywall = config.devFree
      ? undefined
      : createPaywall({ config, store, log, chain, onPaid: (mode) => (mode === "batch" ? batcher.nudge() : poller.nudge()) });
    const app = createApp({
      config,
      store,
      chain,
      log,
      gate: new RegistryGate(chain),
      limiter: new Limiter(2, 10),
      codes: new CodeCache(),
      ...(paywall ? { paywall } : {}),
      batcher,
      poller,
      finalitySource: finality.source,
    });

    let server: Server | undefined;
    let url: string | undefined;
    if (options.listen !== false) {
      server = await new Promise<Server>((resolve, reject) => {
        const s = app.listen(config.port, config.host, (error?: Error) => (error ? reject(error) : resolve(s)));
      });
      const address = server.address() as AddressInfo;
      url = `http://${config.host === "0.0.0.0" ? "127.0.0.1" : config.host}:${address.port}`;
    }
    if (options.loops !== false) {
      batcher.start();
      poller.start();
    }
    paywall?.ready().catch((error) => log.error("x402: payment routes misconfigured; paid routes answer 503", { error: errorText(error) }));

    log.info("service started", {
      url,
      chainId: config.chainId,
      latestBlock,
      registry: config.registry,
      serviceSigner: chain.service.address,
      relayer: chain.relayer.address,
      devFree: config.devFree,
      finality: finality.source,
      batchMaxSize: config.batchMaxSize,
      batchMaxWaitMs: config.batchMaxWaitMs,
    });

    const shutdown = async (): Promise<void> => {
      // New requests stop here. A stalled RPC can hold the loops for minutes, so they do not go first.
      const closed = server ? new Promise<void>((resolve) => server!.close(() => resolve())) : Promise.resolve();
      paywall?.stop();
      let timer: NodeJS.Timeout | undefined;
      const limit = new Promise<void>((resolve) => (timer = setTimeout(resolve, SHUTDOWN_DRAIN_MS)));
      await Promise.race([Promise.all([closed, paywall?.settled(), batcher.stop(), poller.stop()]), limit]);
      clearTimeout(timer);
      server?.closeAllConnections();
      await closed;
      ownDb?.close();
    };
    let stopping: Promise<void> | undefined;
    return {
      config,
      app,
      db,
      store,
      chain,
      batcher,
      poller,
      ...(paywall ? { paywall } : {}),
      ...(server ? { server } : {}),
      ...(url ? { url } : {}),
      stop: () => (stopping ??= shutdown()),
    };
  } catch (error) {
    ownDb?.close();
    throw error;
  }
}

/**
 * Runs before the server listens, so no request of this process can own an unpaid row yet. One
 * with a lease and no outcome was cut off, however long ago: its payment may have moved. Its
 * record, written before settling, keeps the payer and nonce that decide it once the hold ends.
 */
async function holdInterruptedSettlements(store: Store, log: Logger): Promise<void> {
  const now = Date.now();
  for (const row of await store.interruptedSettlements()) {
    const recorded = paymentOf(row);
    log.error("x402: a settlement was cut off by the last shutdown; holding the receipt so a retry is not charged twice", { runId: row.run_id, agent: row.agent, payer: recorded?.payer, nonce: recorded?.nonce });
    await store.notePayment(row.run_id, row.leaf, { ...recorded, status: "settlement_unknown", interrupted: true, at: now }, now, now + SETTLEMENT_HOLD_MS);
  }
}

/**
 * A database belongs to one chain and one registry: its batch ids, proofs and anchors are
 * meaningless anywhere else. Refuse to start if the configuration points somewhere else.
 */
async function bindDatabase(store: Store, config: Config): Promise<void> {
  const binding = `${config.chainId}:${config.registry.toLowerCase()}`;
  const stored = await store.getState("binding");
  if (stored === null) {
    await store.setState("binding", binding, Date.now());
    return;
  }
  if (stored !== binding) {
    const [chainId, registry] = stored.split(":");
    throw new StartupError(
      `database ${config.dbPath} belongs to registry ${registry} on chain ${chainId}, but the configuration is registry ${config.registry} on chain ${config.chainId}; use another DB_PATH`,
    );
  }
}
