import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hashManifest, validateManifest } from "@hemi-receipts/sdk";
import { cli, tempDir } from "./helpers.js";

const dir = tempDir();
after(() => dir.cleanup());
const RUN_ID = `0x${"7e".repeat(32)}`;

test("from-trace on examples/trace.jsonl prints a valid manifest", async () => {
  const r = await cli(["from-trace", "examples/trace.jsonl", "--run-id", RUN_ID]);
  assert.equal(r.code, 0, r.stderr);
  const manifest = JSON.parse(r.stdout);
  assert.ok(validateManifest(manifest).ok);
  assert.equal(manifest.runId, RUN_ID);
  assert.equal(manifest.toolCalls.length, 4);
  assert.equal(manifest.spend.length, 2);
  assert.match(r.stderr, new RegExp(`runId ${RUN_ID}  manifestHash ${hashManifest(manifest)}  \\(4 tool calls, 2 spend\\)`));
});

test("from-trace -o writes the file; flags override the run line", async () => {
  const out = join(dir.path, "m.json");
  const other = "0x9965507d1a55bcc2695c58ba16fb37d819b0a4dc";
  const r = await cli(["from-trace", "examples/trace.jsonl", "-o", out, "--agent", other, "--principal", other, "--model", "claude-opus-5-5"]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, "");
  const manifest = JSON.parse(readFileSync(out, "utf8"));
  assert.equal(manifest.agent, other);
  assert.equal(manifest.principal, other);
  assert.equal(manifest.model, "claude-opus-5-5");
  assert.match(manifest.runId, /^0x[0-9a-f]{64}$/);
});

test("an invalid trace exits 1 and names the lines", async () => {
  const bad = join(dir.path, "bad.jsonl");
  writeFileSync(bad, ['{"type":"run","agent":"0x90f79bf6eb2c4f870365e785982e1f101e93b906","model":"m","startedAt":1,"prompt":"p"}', '{"type":"tool_call","name":"x","at":2}', "{oops", '{"type":"end","endedAt":3,"output":"o"}'].join("\n"));
  const r = await cli(["from-trace", bad]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /bad\.jsonl:3: not valid JSON/);
  const r2 = await cli(["from-trace", bad.replace("bad", "bad2")]);
  assert.equal(r2.code, 2, "missing file is a usage error");
  writeFileSync(bad, readFileSync(bad, "utf8").replace("{oops\n", ""));
  const r3 = await cli(["from-trace", bad]);
  assert.equal(r3.code, 1);
  assert.match(r3.stderr, /bad\.jsonl:2: tool_call "x": "args" or "argsHash" is required/);
});

test("usage errors exit 2", async () => {
  assert.equal((await cli(["from-trace"])).code, 2);
  assert.equal((await cli(["from-trace", "a", "b"])).code, 2);
  const unknown = await cli(["from-trace", "examples/trace.jsonl", "--agnet", "0x1"]);
  assert.equal(unknown.code, 2);
  assert.match(unknown.stderr, /Unknown option '--agnet'/);
  const badOverride = await cli(["from-trace", "examples/trace.jsonl", "--run-id", "0x12"]);
  assert.equal(badOverride.code, 1);
  assert.match(badOverride.stderr, /runId: must be 0x-prefixed lowercase 32-byte hex/);
});

test("help and unknown commands", async () => {
  const help = await cli(["--help"]);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /from-trace .*attest .*status .*fetch .*verify/s);
  assert.equal((await cli([])).code, 2);
  const unknown = await cli(["frobnicate"]);
  assert.equal(unknown.code, 2);
  assert.match(unknown.stderr, /unknown command "frobnicate"/);
  const cmdHelp = await cli(["verify", "--help"]);
  assert.equal(cmdHelp.code, 0);
  assert.match(cmdHelp.stdout, /never contacted/);
});
