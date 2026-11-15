import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { keccak256, stringToBytes, getAddress } from "viem";
import {
  assertManifest,
  canonicalize,
  contentHash,
  hashManifest,
  LIMITS,
  ManifestError,
  newRunId,
  normalizeManifest,
  validateManifest,
  type ManifestV1,
} from "../src/index.js";

const fixture: ManifestV1 = JSON.parse(readFileSync(new URL("../../examples/manifests/fixture-v1.json", import.meta.url), "utf8"));
const H = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const A = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;

/** A fresh deep copy of the fixture with `patch` applied; `undefined` in patch deletes the key. */
function variant(patch: Record<string, unknown> = {}): Record<string, unknown> {
  const m: Record<string, unknown> = structuredClone(fixture) as unknown as Record<string, unknown>;
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete m[k];
    else m[k] = v;
  }
  return m;
}
function call(patch: Record<string, unknown> = {}) {
  return variant({ toolCalls: [{ ...fixture.toolCalls[0], ...patch }] });
}
function spend(patch: Record<string, unknown>) {
  const s: Record<string, unknown> = { asset: "usd", amount: "1", ...patch };
  for (const [k, v] of Object.entries(s)) if (v === undefined) delete s[k];
  return variant({ spend: [s] });
}

function ok(m: unknown) {
  const r = validateManifest(m);
  assert.ok(r.ok, r.ok ? "" : `expected valid, got: ${r.errors.join("; ")}`);
}
function bad(m: unknown, pattern: RegExp) {
  const r = validateManifest(m);
  assert.equal(r.ok, false, `expected invalid (${pattern})`);
  if (!r.ok) assert.ok(r.errors.some((e) => pattern.test(e)), `expected an error matching ${pattern}, got: ${r.errors.join("; ")}`);
}

describe("validateManifest: §1.1 fields", () => {
  test("the fixture is valid", () => ok(fixture));
  test("the minimal manifest (no optional fields, empty arrays) is valid", () =>
    ok(variant({ parentRunId: undefined, tags: undefined, toolCalls: [], spend: [] })));
  test("not an object", () => {
    for (const v of [null, [], "x", 1, true]) bad(v, /must be a JSON object/);
  });

  test("every required field is required", () => {
    for (const field of ["receiptVersion", "runId", "agent", "principal", "startedAt", "endedAt", "model", "promptHash", "outputHash", "toolCalls", "spend"]) {
      bad(variant({ [field]: undefined }), new RegExp(`^${field}: required`));
    }
  });

  test("receiptVersion is exactly 1", () => {
    for (const v of [0, 2, "1", 1.5, -1]) bad(variant({ receiptVersion: v }), /receiptVersion: must be 1/);
  });

  test("runId: lowercase bytes32, not zero", () => {
    ok(variant({ runId: H(1) }));
    bad(variant({ runId: H(0) }), /runId: must not be zero/);
    bad(variant({ runId: fixture.runId.toUpperCase().replace("0X", "0x") }), /runId: must be 0x-prefixed lowercase/);
    bad(variant({ runId: fixture.runId.slice(0, 64) }), /runId: must be/);
    bad(variant({ runId: fixture.runId.slice(2) }), /runId: must be/);
    bad(variant({ runId: `${fixture.runId}00` }), /runId: must be/);
    bad(variant({ runId: 1 }), /runId: must be/);
  });

  test("agent and principal: lowercase address, not zero; principal may equal agent", () => {
    ok(variant({ principal: fixture.agent }));
    for (const key of ["agent", "principal"]) {
      bad(variant({ [key]: A(0) }), new RegExp(`${key}: must not be the zero address`));
      bad(variant({ [key]: getAddress(fixture.agent) }), new RegExp(`${key}: must be a 0x-prefixed lowercase 20-byte address`));
      bad(variant({ [key]: `${fixture.agent}00` }), new RegExp(`${key}: must be`));
      bad(variant({ [key]: "0xzz9fd6e51aad88f6f4ce6ab8827279cfffb92266" }), new RegExp(`${key}: must be`));
    }
  });

  test("startedAt/endedAt: non-negative safe integers, endedAt not before startedAt", () => {
    ok(variant({ startedAt: 0, endedAt: 0 }));
    ok(variant({ startedAt: 5, endedAt: 5 }));
    ok(variant({ startedAt: 0, endedAt: Number.MAX_SAFE_INTEGER }));
    for (const key of ["startedAt", "endedAt"]) {
      for (const v of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, "1793300000", Number.NaN]) {
        bad(variant({ [key]: v }), new RegExp(`${key}: must be a non-negative safe integer`));
      }
    }
    bad(variant({ startedAt: 10, endedAt: 9 }), /endedAt: must not be before startedAt/);
  });

  test("model: 1 to 256 UTF-16 code units, no lone surrogates", () => {
    ok(variant({ model: "m" }));
    ok(variant({ model: "x".repeat(256) }));
    ok(variant({ model: "😀".repeat(128) })); // 256 code units
    bad(variant({ model: "😀".repeat(128) + "x" }), /model: must be at most 256/);
    bad(variant({ model: "x".repeat(257) }), /model: must be at most 256/);
    bad(variant({ model: "" }), /model: must not be empty/);
    bad(variant({ model: 5 }), /model: must be a string/);
    bad(variant({ model: "a\ud800b" }), /model: contains a lone surrogate/);
  });

  test("promptHash/outputHash: lowercase bytes32", () => {
    for (const key of ["promptHash", "outputHash"]) {
      ok(variant({ [key]: H(0) }));
      bad(variant({ [key]: H(1).replace("1", "A").replace("0x0", "0xA") }), new RegExp(`${key}: must be 0x-prefixed lowercase`));
      bad(variant({ [key]: "0x1234" }), new RegExp(`${key}: must be`));
    }
  });

  test("toolCalls: array of closed ToolCall objects, at most 10,000", () => {
    bad(variant({ toolCalls: {} }), /toolCalls: must be an array/);
    bad(variant({ toolCalls: [1] }), /toolCalls\[0\]: must be an object/);
    // 10,000 is allowed by the count rule, but 10,000 tool calls (>= 182 canonical bytes each) can
    // never fit the 1 MiB canonical limit, so the size rule is what rejects them.
    const many = Array.from({ length: LIMITS.toolCalls }, () => fixture.toolCalls[0]);
    const atLimit = validateManifest(variant({ toolCalls: many }));
    assert.equal(atLimit.ok, false);
    if (!atLimit.ok) {
      assert.ok(!atLimit.errors.some((e) => /at most 10000/.test(e)));
      assert.match(atLimit.errors.join(), /canonical form is \d+ bytes/);
    }
    bad(variant({ toolCalls: [...many, fixture.toolCalls[0]] }), /toolCalls: at most 10000 entries/);
    ok(variant({ toolCalls: many.slice(0, 5_000) }));
    for (const field of ["name", "argsHash", "resultHash", "at"]) bad(call({ [field]: undefined }), new RegExp(`toolCalls\\[0\\]\\.${field}: required`));
    bad(call({ extra: 1 }), /toolCalls\[0\]\.extra: unknown field/);
    bad(call({ name: null }), /toolCalls\[0\]\.name: must be omitted rather than null/);
  });

  test("ToolCall.name: 1 to 128 characters", () => {
    ok(call({ name: "n".repeat(128) }));
    bad(call({ name: "n".repeat(129) }), /toolCalls\[0\]\.name: must be at most 128/);
    bad(call({ name: "" }), /toolCalls\[0\]\.name: must not be empty/);
    bad(call({ name: 7 }), /toolCalls\[0\]\.name: must be a string/);
  });

  test("ToolCall.argsHash/resultHash: bytes32; at: integer", () => {
    bad(call({ argsHash: "0x00" }), /argsHash: must be 0x-prefixed lowercase/);
    bad(call({ resultHash: `0x${fixture.toolCalls[0]!.resultHash.slice(2).toUpperCase()}` }), /toolCalls\[0\]\.resultHash: must be 0x-prefixed lowercase/);
    ok(call({ at: 0 }));
    bad(call({ at: -5 }), /toolCalls\[0\]\.at: must be a non-negative safe integer/);
    bad(call({ at: "10" }), /toolCalls\[0\]\.at/);
  });

  test("spend: array of closed Spend objects, at most 1,000", () => {
    bad(variant({ spend: "none" }), /spend: must be an array/);
    bad(variant({ spend: [null] }), /spend\[0\]: must be an object/);
    const many = Array.from({ length: LIMITS.spend }, () => ({ asset: "usd", amount: "1" }));
    ok(variant({ spend: many }));
    bad(variant({ spend: [...many, { asset: "usd", amount: "1" }] }), /spend: at most 1000 entries/);
    bad(spend({ asset: undefined }), /spend\[0\]\.asset: required/);
    bad(spend({ amount: undefined }), /spend\[0\]\.amount: required/);
    bad(spend({ memo: "x" }), /spend\[0\]\.memo: unknown field/);
    bad(spend({ txHash: null }), /spend\[0\]\.txHash: must be omitted rather than null/);
  });

  test("Spend.asset: 1 to 256 characters", () => {
    ok(spend({ asset: "a".repeat(256) }));
    ok(spend({ asset: "eip155:743111/erc20:0xd47971c7f5b1067d25cd45d30b2c9eb60de96443" }));
    bad(spend({ asset: "a".repeat(257) }), /spend\[0\]\.asset: must be at most 256/);
    bad(spend({ asset: "" }), /spend\[0\]\.asset: must not be empty/);
  });

  test("Spend.amount: canonical decimal string, at most 78 characters", () => {
    for (const v of ["0", "1000", "0.5", "0.0042", "10.25", "9".repeat(78), "1." + "0".repeat(75) + "1"]) ok(spend({ amount: v }));
    for (const v of ["01", "1.50", "1e3", "-1", "+1", "", ".5", "1.", "0.0", "00", " 1", "1,000", "9".repeat(79), 1000, 0.5]) {
      bad(spend({ amount: v }), /spend\[0\]\.amount: must be a canonical non-negative decimal string/);
    }
  });

  test("Spend.txHash: optional bytes32", () => {
    ok(spend({ txHash: H(9) }));
    bad(spend({ txHash: "0x1" }), /spend\[0\]\.txHash: must be 0x-prefixed lowercase/);
  });

  test("parentRunId: optional bytes32, different from runId", () => {
    ok(variant({ parentRunId: undefined }));
    ok(variant({ parentRunId: H(0) }));
    bad(variant({ parentRunId: fixture.runId }), /parentRunId: must differ from runId/);
    bad(variant({ parentRunId: "0xabc" }), /parentRunId: must be 0x-prefixed lowercase/);
  });

  test("tags: at most 32 unique strings of 1 to 64 characters", () => {
    ok(variant({ tags: [] }));
    ok(variant({ tags: Array.from({ length: 32 }, (_, i) => `t${i}`) }));
    ok(variant({ tags: ["t".repeat(64)] }));
    bad(variant({ tags: Array.from({ length: 33 }, (_, i) => `t${i}`) }), /tags: at most 32 entries/);
    bad(variant({ tags: ["a", "b", "a"] }), /tags\[2\]: duplicate tag "a"/);
    bad(variant({ tags: ["t".repeat(65)] }), /tags\[0\]: must be at most 64/);
    bad(variant({ tags: [""] }), /tags\[0\]: must not be empty/);
    bad(variant({ tags: [1] }), /tags\[0\]: must be a string/);
    bad(variant({ tags: "fixture" }), /tags: must be an array of strings/);
  });
});

describe("validateManifest: §1.2 further rules", () => {
  test("the object is closed: unknown fields are rejected", () => {
    bad(variant({ note: "hi" }), /^note: unknown field/);
    bad(variant({ receiptversion: 1 }), /^receiptversion: unknown field/);
  });

  test("null is rejected for optional and required fields; optional fields are omitted", () => {
    bad(variant({ parentRunId: null }), /parentRunId: must be omitted rather than null/);
    bad(variant({ tags: null }), /tags: must be omitted rather than null/);
    bad(variant({ model: null }), /model: must be omitted rather than null/);
  });

  test("toolCalls and spend are required even when empty", () => {
    bad(variant({ toolCalls: undefined }), /toolCalls: required/);
    bad(variant({ spend: undefined }), /spend: required/);
    ok(variant({ toolCalls: [], spend: [] }));
  });

  test("the canonical form may be at most 1 MiB", () => {
    const big = Array.from({ length: 4_000 }, (_, i) => ({ ...fixture.toolCalls[0], name: `${i}`.padEnd(128, "x") }));
    const r = validateManifest(variant({ toolCalls: big }));
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.errors[0]!, /manifest: canonical form is \d+ bytes; the limit is 1048576/);
    const small = big.slice(0, 1_000);
    ok(variant({ toolCalls: small }));
  });

  test("validateManifest never changes its input", () => {
    const m = variant({ runId: fixture.runId.toUpperCase().replace("0X", "0x") });
    const before = structuredClone(m);
    validateManifest(m);
    assert.deepEqual(m, before);
    const frozen = Object.freeze(structuredClone(fixture));
    ok(frozen);
  });

  test("undefined members count as absent", () => {
    ok({ ...structuredClone(fixture), parentRunId: undefined });
    bad({ ...structuredClone(fixture), model: undefined }, /model: required/);
  });

  test("assertManifest throws ManifestError with every problem", () => {
    assert.throws(
      () => assertManifest(variant({ model: "", runId: H(0) })),
      (e: unknown) => e instanceof ManifestError && e.errors.length === 2 && /model/.test(e.message) && /runId/.test(e.message),
    );
    assert.deepEqual(assertManifest(fixture), fixture);
  });
});

describe("normalizeManifest", () => {
  test("lowercases hex and addresses (EIP-55 accepted) and drops undefined members", () => {
    const upper = (h: string) => `0x${h.slice(2).toUpperCase()}`;
    const messy = {
      ...structuredClone(fixture),
      runId: upper(fixture.runId),
      agent: getAddress(fixture.agent),
      principal: upper(fixture.principal),
      promptHash: upper(fixture.promptHash),
      outputHash: upper(fixture.outputHash),
      parentRunId: upper(fixture.parentRunId!),
      toolCalls: fixture.toolCalls.map((c) => ({ ...c, argsHash: upper(c.argsHash), resultHash: upper(c.resultHash), extra: undefined })),
      spend: fixture.spend.map((s) => ({ ...s, ...(s.txHash ? { txHash: upper(s.txHash) } : {}), memo: undefined })),
      tags: fixture.tags,
      nothing: undefined,
    };
    const before = structuredClone(messy);
    const normalized = normalizeManifest(messy);
    assert.deepEqual(normalized, fixture);
    assert.equal(hashManifest(normalized), hashManifest(fixture));
    assert.deepEqual(messy, before, "input is not mutated");
    assert.deepEqual(normalizeManifest(normalized), normalized, "idempotent");
  });

  test("leaves what it cannot fix for validation", () => {
    assert.throws(() => normalizeManifest(variant({ tags: null })), /tags: must be omitted rather than null/);
    assert.throws(() => normalizeManifest(variant({ extra: 1 })), /extra: unknown field/);
    assert.throws(() => normalizeManifest(variant({ startedAt: "1793300000" })), /startedAt/);
    assert.throws(() => normalizeManifest(variant({ runId: "0x12" })), /runId/);
    assert.throws(() => normalizeManifest([]), ManifestError);
  });
});

describe("hashing", () => {
  test("manifestHash = keccak256(UTF-8(JCS(manifest)))", () => {
    assert.equal(hashManifest(fixture), keccak256(stringToBytes(canonicalize(fixture))));
  });

  test("member order and whitespace do not change the hash; tag order does", () => {
    const reordered = Object.fromEntries(Object.entries(structuredClone(fixture)).reverse());
    assert.equal(hashManifest(reordered), hashManifest(fixture));
    assert.equal(hashManifest(JSON.parse(JSON.stringify(fixture, null, 7))), hashManifest(fixture));
    assert.notEqual(hashManifest(variant({ tags: [...fixture.tags!].reverse() })), hashManifest(fixture));
  });

  test("hashManifest refuses an invalid manifest", () => {
    assert.throws(() => hashManifest(variant({ model: "" })), ManifestError);
  });

  test("contentHash: strings as UTF-8, bytes as bytes, other JSON values canonically", () => {
    assert.equal(contentHash("abc"), "0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45");
    assert.equal(contentHash("café"), keccak256(stringToBytes("café")));
    assert.equal(contentHash(new Uint8Array([1, 2, 3])), keccak256(new Uint8Array([1, 2, 3])));
    assert.equal(contentHash({ b: 1, a: [true, null] }), keccak256(stringToBytes('{"a":[true,null],"b":1}')));
    assert.equal(contentHash({ a: 1, b: 2 }), contentHash({ b: 2, a: 1 }));
    assert.equal(contentHash(42), keccak256(stringToBytes("42")));
    assert.notEqual(contentHash("42"), contentHash("42 "));
    assert.throws(() => contentHash({ x: Number.NaN }), /non-finite/);
  });

  test("newRunId: 32 random lowercase bytes", () => {
    const ids = new Set(Array.from({ length: 50 }, newRunId));
    assert.equal(ids.size, 50);
    for (const id of ids) assert.match(id, /^0x[0-9a-f]{64}$/);
  });
});
