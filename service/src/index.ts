/**
 * hemi-agent-receipts service entry point: `node dist/index.js` (config from the environment;
 * see service/README.md and the root .env.example).
 */
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { ConfigError, loadConfig } from "./config.js";
import { StartupError } from "./chain.js";
import { createLogger, errorText } from "./log.js";
import { startService, type RunningService } from "./service.js";

export { loadConfig, ConfigError } from "./config.js";
export { startService, type RunningService, type ServiceOptions } from "./service.js";
export { StartupError } from "./chain.js";

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig(process.env);
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`[receipts] refusing to start: ${error.message}`);
      process.exit(1);
    }
    throw error;
  }
  const log = createLogger(config.logLevel);
  // Installed before startup, which can wait minutes on a stalled RPC: a stop then exits at once,
  // since nothing has been served. Once serving, every signal joins one graceful stop, which waits
  // for paid requests in flight; only SIGKILL cuts it short (the next start holds what it cut off).
  let service: RunningService | undefined;
  let stopping = false;
  const onSignal = (signal: NodeJS.Signals) => {
    if (!service) {
      log.info("stopped during startup", { signal });
      process.exit(0);
    }
    if (stopping) {
      log.warn("already shutting down; waiting for paid requests in flight (SIGKILL stops at once)", { signal });
      return;
    }
    stopping = true;
    log.info("shutting down", { signal });
    service.stop().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
  try {
    service = await startService(config, { log });
  } catch (error) {
    if (error instanceof StartupError) {
      log.error(`refusing to start: ${error.message}`);
    } else {
      log.error("startup failed", { error: errorText(error) });
    }
    process.exit(1);
  }
}

const isEntry = process.argv[1] !== undefined && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (isEntry) void main();
