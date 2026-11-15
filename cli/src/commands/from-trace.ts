import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { hashManifest, parseTraceJsonl, TraceError, type TraceOverrides } from "@hemi-receipts/sdk";
import { EXIT, Failure, json, readText, UsageError, type Io } from "../io.js";
import { parse } from "../args.js";

export const usage = `receipts from-trace <trace.jsonl> [--agent ADDR] [--principal ADDR] [--model NAME] [--run-id HEX] [-o manifest.json]

Builds a v1 manifest from a trace (docs/SCHEMA.md §6). Raw prompt, output, tool arguments and
results are hashed with contentHash; only hashes reach the manifest. The flags override the
trace's run line. Writes the manifest to -o, or to stdout.`;

export async function fromTrace(argv: string[], io: Io): Promise<number> {
  const { values, positionals } = parse(argv, {
    agent: { type: "string" },
    principal: { type: "string" },
    model: { type: "string" },
    "run-id": { type: "string" },
    output: { type: "string", short: "o" },
  });
  if (positionals.length !== 1) throw new UsageError("give exactly one trace file");
  const path = positionals[0]!;
  const overrides: TraceOverrides = {};
  if (values.agent !== undefined) overrides.agent = values.agent;
  if (values.principal !== undefined) overrides.principal = values.principal;
  if (values.model !== undefined) overrides.model = values.model;
  if (values["run-id"] !== undefined) overrides.runId = values["run-id"];

  const text = await readText(path, io);
  let manifest;
  try {
    manifest = parseTraceJsonl(text, overrides);
  } catch (error) {
    if (!(error instanceof TraceError)) throw error;
    for (const issue of error.issues) io.err(`${path}${issue.line ? `:${issue.line}` : ""}: ${issue.message}`);
    throw new Failure(`${path}: ${error.issues.length} problem${error.issues.length > 1 ? "s" : ""}; no manifest written`);
  }
  const body = `${json(manifest)}\n`;
  if (values.output && values.output !== "-") {
    await writeFile(resolve(io.cwd, values.output), body);
    io.err(`wrote ${values.output}`);
  } else io.out(body);
  io.err(`runId ${manifest.runId}  manifestHash ${hashManifest(manifest)}  (${manifest.toolCalls.length} tool calls, ${manifest.spend.length} spend)`);
  return EXIT.ok;
}
