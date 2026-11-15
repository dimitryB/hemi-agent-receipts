/**
 * Runs the service in a child process and SIGKILLs it at a chosen point of the batcher's
 * state machine (CRASH_AT=beforeBroadcast | afterBroadcast), to test restart recovery
 * against a real crash rather than a polite stop. CRASH_AT=none leaves the kill to the test.
 */
import { loadConfig } from "../../src/config.js";
import { createLogger, silentLogger } from "../../src/log.js";
import { startService } from "../../src/service.js";

const crashAt = process.env.CRASH_AT;
if (crashAt !== "beforeBroadcast" && crashAt !== "afterBroadcast" && crashAt !== "none") throw new Error("CRASH_AT must be beforeBroadcast, afterBroadcast or none");

const die = (): Promise<void> => {
  process.kill(process.pid, "SIGKILL");
  return new Promise(() => undefined);
};

const service = await startService(loadConfig(process.env), {
  log: process.env.TEST_LOG_LEVEL ? createLogger("info", (line) => console.error(`[child] ${line}`)) : silentLogger,
  faults: crashAt === "none" ? {} : { [crashAt]: die },
});
process.stdout.write(`${JSON.stringify({ url: service.url })}\n`);
