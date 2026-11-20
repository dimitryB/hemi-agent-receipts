/**
 * docs/SCHEMA.md and the SDK cannot drift. The field tables, the pinned
 * fixture and its digests in the doc are compared with the SDK here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  hashManifest,
  leafHash,
  MANIFEST_V1_FIELDS,
  receiptFromManifest,
  SPEND_V1_FIELDS,
  TOOL_CALL_V1_FIELDS,
  validateManifest,
  type FieldSpec,
} from "../src/index.js";

const doc = readFileSync(new URL("../../docs/SCHEMA.md", import.meta.url), "utf8");
const fixtureFile = JSON.parse(readFileSync(new URL("../../examples/manifests/fixture-v1.json", import.meta.url), "utf8"));

function section(name: string): string {
  const start = `<!-- ${name}:start -->`;
  const end = `<!-- ${name}:end -->`;
  const i = doc.indexOf(start);
  const j = doc.indexOf(end);
  assert.ok(i >= 0 && j > i, `docs/SCHEMA.md has no ${start} … ${end} section`);
  assert.equal(doc.indexOf(start, i + 1), -1, `${start} appears twice`);
  return doc.slice(i + start.length, j);
}

/** Rows of a markdown table as arrays of trimmed cells, header and separator dropped. */
function tableRows(text: string): string[][] {
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("|"));
  assert.ok(lines.length >= 2, "expected a markdown table");
  return lines.slice(2).map((line) =>
    line
      .slice(1, -1)
      .split(/(?<!\\)\|/)
      .map((cell) => cell.trim()),
  );
}

function fieldsFromDoc(name: string): FieldSpec[] {
  return tableRows(section(name)).map(([field, type, required]) => {
    const m = /^`([A-Za-z]+)`$/.exec(field ?? "");
    assert.ok(m, `${name}: field cell ${field} is not a single \`name\``);
    assert.ok(required === "yes" || required === "no", `${name}: required cell for ${field} is ${required}`);
    return { name: m[1]!, type: type as FieldSpec["type"], required: required === "yes" };
  });
}

for (const [name, fields] of [
  ["manifest-v1-fields", MANIFEST_V1_FIELDS],
  ["toolcall-v1-fields", TOOL_CALL_V1_FIELDS],
  ["spend-v1-fields", SPEND_V1_FIELDS],
] as const) {
  test(`SCHEMA.md ${name} table matches the SDK (name, type, required, order)`, () => {
    assert.deepEqual(fieldsFromDoc(name), fields.map((f) => ({ name: f.name, type: f.type, required: f.required })));
  });
}

function fixtureFromDoc(): unknown {
  const body = section("fixture-v1");
  const m = /```json\n([\s\S]*?)\n```/.exec(body);
  assert.ok(m, "fixture-v1 section has no ```json block");
  return JSON.parse(m[1]!);
}

function pinned(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [label, value] of tableRows(section("fixture-v1-digest"))) {
    const m = /^`(0x[0-9a-f]{64})`$/.exec(value ?? "");
    assert.ok(m, `digest cell for ${label} is not a backticked bytes32`);
    out[label!] = m[1]!;
  }
  return out;
}

test("the fixture in SCHEMA.md equals examples/manifests/fixture-v1.json", () => {
  assert.deepEqual(fixtureFromDoc(), fixtureFile);
});

test("the fixture validates and hashes to the pinned manifestHash and leaf", () => {
  const fixture = fixtureFromDoc();
  const result = validateManifest(fixture);
  assert.ok(result.ok, result.ok ? "" : result.errors.join("; "));
  const digests = pinned();
  assert.deepEqual(Object.keys(digests).sort(), ["leaf", "manifestHash"]);
  assert.equal(hashManifest(fixture), digests.manifestHash);
  assert.equal(leafHash(receiptFromManifest(result.manifest)), digests.leaf);
});
