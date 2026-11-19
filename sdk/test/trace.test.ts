import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildManifest, contentHash, hashManifest, parseTraceJsonl, TraceError, validateManifest, type Trace } from "../src/index.js";

const example = readFileSync(new URL("../../examples/trace.jsonl", import.meta.url), "utf8");
const RUN_ID = `0x${"5a".repeat(32)}`;
const AGENT = "0x90f79bf6eb2c4f870365e785982e1f101e93b906";
const PRINCIPAL = "0x15d34aaf54267db7d7c367839aaf71a00a2c6a65";
const H = (c: string) => `0x${c.repeat(64)}`;

function traceError(fn: () => unknown, line: number | undefined, pattern: RegExp) {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof TraceError, `expected TraceError, got ${error}`);
    const hit = error.issues.find((i) => i.line === line && pattern.test(i.message));
    assert.ok(hit, `expected an issue at line ${line} matching ${pattern}; got ${JSON.stringify(error.issues)}`);
    if (line !== undefined) assert.match(error.message, new RegExp(`line ${line}: `));
    return true;
  });
}

const lines = (...objs: unknown[]) => objs.map((o) => (typeof o === "string" ? o : JSON.stringify(o))).join("\n");
const run = (extra: Record<string, unknown> = {}) => ({ type: "run", agent: AGENT, model: "m", startedAt: 100, prompt: "p", ...extra });
const end = (extra: Record<string, unknown> = {}) => ({ type: "end", endedAt: 200, output: "o", ...extra });
const tool = (extra: Record<string, unknown> = {}) => ({ type: "tool_call", name: "t", at: 150, args: {}, result: "r", ...extra });

describe("parseTraceJsonl: examples/trace.jsonl", () => {
  test("parses to a valid manifest", () => {
    const m = parseTraceJsonl(example, { runId: RUN_ID });
    assert.ok(validateManifest(m).ok);
    assert.equal(m.runId, RUN_ID);
    assert.equal(m.agent, AGENT);
    assert.equal(m.principal, PRINCIPAL);
    assert.equal(m.model, "claude-fable-5-1");
    assert.equal(m.startedAt, 1793282531, "ISO 8601 startedAt becomes unix seconds");
    assert.equal(m.endedAt, 1793282642);
    assert.ok(m.toolCalls.length >= 3);
    assert.deepEqual(m.toolCalls.map((c) => c.name), ["web_search", "fetch_url", "rpc_call", "run_python"]);
    assert.equal(m.spend.length, 2);
    assert.deepEqual(m.tags, ["research", "hemi-pop"]);
    assert.equal(m.parentRunId, undefined);
  });

  test("raw payloads are hashed with contentHash; given hashes are kept", () => {
    const events = example.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
    const m = parseTraceJsonl(example, { runId: RUN_ID });
    assert.equal(m.promptHash, contentHash(events[0].prompt));
    assert.equal(m.outputHash, contentHash(events.at(-1).output));
    assert.equal(m.toolCalls[0]!.argsHash, contentHash(events[1].args));
    assert.equal(m.toolCalls[0]!.resultHash, contentHash(events[1].result));
    assert.equal(m.toolCalls[2]!.resultHash, events[4].resultHash);
    // The example names no transaction: a made-up hash would fail verify's spend check.
    assert.equal(m.spend[0]!.txHash, undefined);
    const tx = `0x${"ab".repeat(32)}`;
    const withTx = parseTraceJsonl(example.replace('"amount":"1000"}', `"amount":"1000","txHash":"${tx}"}`), { runId: RUN_ID });
    assert.equal(withTx.spend[0]!.txHash, tx, "a spend line's txHash is kept");
  });

  test("deterministic for a fixed runId; random runId otherwise", () => {
    assert.equal(hashManifest(parseTraceJsonl(example, { runId: RUN_ID })), hashManifest(parseTraceJsonl(example, { runId: RUN_ID })));
    assert.notEqual(parseTraceJsonl(example).runId, parseTraceJsonl(example).runId);
  });

  test("overrides win over the run line", () => {
    const other = "0x9965507d1a55bcc2695c58ba16fb37d819b0a4dc";
    const m = parseTraceJsonl(example, { agent: other, principal: other, model: "claude-opus-5-5", runId: RUN_ID.toUpperCase().replace("0X", "0x") });
    assert.equal(m.agent, other);
    assert.equal(m.principal, other);
    assert.equal(m.model, "claude-opus-5-5");
    assert.equal(m.runId, RUN_ID, "runId lowercased by normalization");
  });
});

describe("parseTraceJsonl: rules", () => {
  test("principal defaults to agent (including an overridden agent)", () => {
    const text = lines(run(), end());
    assert.equal(parseTraceJsonl(text).principal, AGENT);
    const other = "0x9965507d1a55bcc2695c58ba16fb37d819b0a4dc";
    assert.equal(parseTraceJsonl(text, { agent: other }).principal, other);
  });

  test("blank lines and CRLF are fine; empty arrays when there are no tool calls or spend", () => {
    const m = parseTraceJsonl(`\n${JSON.stringify(run())}\r\n\r\n   \n${JSON.stringify(end())}\n`);
    assert.deepEqual(m.toolCalls, []);
    assert.deepEqual(m.spend, []);
  });

  test("hashes may be given instead of raw payloads, in any case", () => {
    const m = parseTraceJsonl(lines(run({ prompt: undefined, promptHash: H("A") }), tool({ args: undefined, argsHash: H("b"), result: undefined, resultHash: H("c") }), end({ output: undefined, outputHash: H("d") })));
    assert.equal(m.promptHash, H("a"));
    assert.deepEqual([m.toolCalls[0]!.argsHash, m.toolCalls[0]!.resultHash, m.outputHash], [H("b"), H("c"), H("d")]);
  });

  test("spend amounts: strings kept, safe integers converted, fractions must be strings", () => {
    const m = parseTraceJsonl(lines(run(), { type: "spend", asset: "usd", amount: 25 }, { type: "spend", asset: "usd", amount: "0.25" }, end()));
    assert.deepEqual(m.spend.map((s) => s.amount), ["25", "0.25"]);
    traceError(() => parseTraceJsonl(lines(run(), { type: "spend", asset: "usd", amount: 0.25 }, end())), 2, /amount: must be a canonical decimal string/);
    traceError(() => parseTraceJsonl(lines(run(), { type: "spend", asset: "usd", amount: "1.50" }, end())), 2, /spend\[0\]\.amount/);
  });

  test("parentRunId and tags pass through", () => {
    const m = parseTraceJsonl(lines(run({ parentRunId: H("1"), tags: ["x", "y"] }), end()));
    assert.equal(m.parentRunId, H("1"));
    assert.deepEqual(m.tags, ["x", "y"]);
  });
});

describe("parseTraceJsonl: errors carry line numbers", () => {
  test("invalid JSON", () => traceError(() => parseTraceJsonl(lines(run(), "{not json", end())), 2, /not valid JSON/));
  test("a line that is not an object", () => traceError(() => parseTraceJsonl(lines(run(), "[1,2]", end())), 2, /must be a JSON object/));
  test("unknown type", () => traceError(() => parseTraceJsonl(lines(run(), { type: "thought" }, end())), 2, /unknown type "thought"/));
  test("unknown field (a typo never silently drops out of the hash)", () =>
    traceError(() => parseTraceJsonl(lines(run(), tool({ reslt: "x" }), end())), 2, /tool_call: unknown field "reslt"/));
  test("empty input", () => traceError(() => parseTraceJsonl("\n \n"), undefined, /trace is empty/));
  test("first line must be run", () => traceError(() => parseTraceJsonl(lines(tool(), run(), end())), 1, /first line must be a "run" line/));
  test("last line must be end", () => traceError(() => parseTraceJsonl(lines(run(), end(), tool())), 3, /last line must be an "end" line/));
  test("a second run line", () => traceError(() => parseTraceJsonl(lines(run(), run(), end())), 2, /second "run" line/));
  test("a second end line", () => traceError(() => parseTraceJsonl(lines(run(), end(), end())), 2, /"end" line before the last line/));
  test("missing agent", () => traceError(() => parseTraceJsonl(lines(run({ agent: undefined }), end())), 1, /agent: required/));
  test("missing model", () => traceError(() => parseTraceJsonl(lines(run({ model: undefined }), end())), 1, /model: required/));
  test("prompt and promptHash both given", () => traceError(() => parseTraceJsonl(lines(run({ promptHash: H("1") }), end())), 1, /either "prompt" or "promptHash", not both/));
  test("neither output nor outputHash", () => traceError(() => parseTraceJsonl(lines(run(), end({ output: undefined }))), 2, /"output" or "outputHash" is required/));
  test("tool call without args", () => traceError(() => parseTraceJsonl(lines(run(), tool({ args: undefined }), end())), 2, /tool_call "t": "args" or "argsHash" is required/));
  test("bad timestamps", () => {
    traceError(() => parseTraceJsonl(lines(run({ startedAt: -1 }), end())), 1, /startedAt: must be non-negative integer unix seconds/);
    traceError(() => parseTraceJsonl(lines(run(), tool({ at: "yesterday" }), end())), 2, /at: must be non-negative integer unix seconds or an ISO 8601/);
    traceError(() => parseTraceJsonl(lines(run(), end({ endedAt: 50 }))), 2, /endedAt: must not be before startedAt/);
  });
  test("manifest rule violations point at the line that caused them", () => {
    traceError(() => parseTraceJsonl(lines(run(), tool(), tool({ name: "" }), end())), 3, /toolCalls\[1\]\.name: must not be empty/);
    traceError(() => parseTraceJsonl(lines(run({ agent: "0x1234" }), end())), 1, /agent: must be a 0x-prefixed lowercase 20-byte address/);
    traceError(() => parseTraceJsonl(lines(run(), { type: "spend", asset: "", amount: "1" }, end())), 2, /spend\[0\]\.asset: must not be empty/);
    traceError(() => parseTraceJsonl(lines(run({ tags: ["a", "a"] }), end())), 1, /duplicate tag/);
  });
  test("every problem is reported at once", () => {
    assert.throws(
      () => parseTraceJsonl(lines(run(), "{bad", { type: "nope" }, end())),
      (e: unknown) => e instanceof TraceError && e.issues.length === 2 && e.issues[0]!.line === 2 && e.issues[1]!.line === 3,
    );
  });
});

describe("buildManifest from a structured trace", () => {
  const trace: Trace = {
    agent: AGENT,
    model: "claude-fable-5-1",
    runId: RUN_ID,
    startedAt: 1_000,
    endedAt: "1970-01-01T00:20:00Z",
    prompt: { messages: [{ role: "user", content: "hi" }] },
    output: "hello",
    toolCalls: [{ name: "lookup", at: 1_100, args: ["a", 1], resultHash: H("e") }],
    spend: [{ asset: "usd", amount: 3n }],
  };

  test("builds the same manifest as the equivalent JSONL", () => {
    const m = buildManifest(trace);
    assert.equal(m.endedAt, 1_200);
    assert.equal(m.principal, AGENT);
    assert.equal(m.promptHash, contentHash(trace.prompt));
    assert.deepEqual(m.spend, [{ asset: "usd", amount: "3" }]);
    const jsonl = lines(
      { type: "run", agent: AGENT, model: "claude-fable-5-1", runId: RUN_ID, startedAt: 1_000, prompt: trace.prompt },
      { type: "tool_call", name: "lookup", at: 1_100, args: ["a", 1], resultHash: H("e") },
      { type: "spend", asset: "usd", amount: "3" },
      { type: "end", endedAt: 1_200, output: "hello" },
    );
    assert.deepEqual(parseTraceJsonl(jsonl), m);
  });

  test("errors have no line numbers but say what is wrong", () => {
    traceError(() => buildManifest({ ...trace, toolCalls: [{ name: "x", at: 1 }] }), undefined, /tool_call "x": "args" or "argsHash" is required/);
    traceError(() => buildManifest({ ...trace, model: "" }), undefined, /model: must not be empty/);
    assert.throws(() => buildManifest(null as unknown as Trace), TraceError);
  });
});
