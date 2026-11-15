import { ServiceError } from "@hemi-receipts/sdk";
import { attest, usage as attestUsage } from "./commands/attest.js";
import { fetchReceipt, usage as fetchUsage } from "./commands/fetch.js";
import { fromTrace, usage as fromTraceUsage } from "./commands/from-trace.js";
import { status, usage as statusUsage } from "./commands/status.js";
import { verifyCommand, usage as verifyUsage } from "./commands/verify.js";
import { defaultIo, EXIT, Failure, UsageError, type Io } from "./io.js";

const COMMANDS: Record<string, { run: (argv: string[], io: Io) => Promise<number>; usage: string; summary: string }> = {
  "from-trace": { run: fromTrace, usage: fromTraceUsage, summary: "build a manifest from a trace JSONL file" },
  attest: { run: attest, usage: attestUsage, summary: "sign manifests and submit them to the receipts service" },
  status: { run: status, usage: statusUsage, summary: "show a receipt's finality stage" },
  fetch: { run: fetchReceipt, usage: fetchUsage, summary: "save a receipt file from the service" },
  verify: { run: verifyCommand, usage: verifyUsage, summary: "verify a receipt file against the chain only" },
};

export const HELP = `receipts: Bitcoin-anchored receipts for AI agent runs, on Hemi

Usage: receipts <command> [options]

${Object.entries(COMMANDS)
  .map(([name, c]) => `  ${name.padEnd(12)}${c.summary}`)
  .join("\n")}

Run "receipts <command> --help" for a command's options.
Exit status: 0 success/valid, 1 failed/invalid, 2 usage or runtime error.`;

/** Runs the CLI in-process and returns the exit code. */
export async function run(argv: string[], partial: Partial<Io> = {}): Promise<number> {
  const io: Io = { ...defaultIo(), ...partial };
  const [name, ...rest] = argv;
  if (!name || name === "help" || name === "--help" || name === "-h") {
    io.out(HELP);
    return name ? EXIT.ok : EXIT.usage;
  }
  const command = COMMANDS[name];
  if (!command) {
    io.err(`receipts: unknown command "${name}"\n\n${HELP}`);
    return EXIT.usage;
  }
  if (rest.includes("--help") || rest.includes("-h")) {
    io.out(command.usage);
    return EXIT.ok;
  }
  try {
    return await command.run(rest, io);
  } catch (error) {
    if (error instanceof UsageError) {
      io.err(`receipts ${name}: ${error.message}\n\nUsage: ${command.usage.split("\n\n")[0]}`);
      return EXIT.usage;
    }
    if (error instanceof Failure) {
      io.err(`receipts ${name}: ${error.message}`);
      return EXIT.failed;
    }
    if (error instanceof ServiceError) {
      io.err(`receipts ${name}: ${error.message}`);
      return error.status === 0 ? EXIT.usage : EXIT.failed;
    }
    io.err(`receipts ${name}: ${error instanceof Error ? error.message : String(error)}`);
    return EXIT.usage;
  }
}
