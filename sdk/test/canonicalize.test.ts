import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalize, CanonicalizationError } from "../src/index.js";

test("RFC 8785 §3.2.2: numbers, literals and string escaping", () => {
  // The JSON text of RFC 8785 §3.2.2 (ordinary string literals: esbuild rewrites \u escapes inside String.raw).
  const input = JSON.parse(
    '{"numbers": [333333333.33333329, 1E30, 4.50, 2e-3, 0.000000000000000000000000001],' +
      ' "string": "\\u20ac$\\u000F\\u000aA\'\\u0042\\u0022\\u005c\\\\\\"\\/",' +
      ' "literals": [null, true, false]}',
  );
  assert.equal(input.string, "€$\u000f\nA'B\"\\\\\"/");
  const expected =
    '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"€$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}';
  assert.equal(canonicalize(input), expected);
});

test("RFC 8785 §3.2.3: members sorted by UTF-16 code units", () => {
  const input = JSON.parse(String.raw`{
    "€": "Euro Sign",
    "\r": "Carriage Return",
    "דּ": "Hebrew Letter Dalet With Dagesh",
    "1": "One",
    "😀": "Emoji: Grinning Face",
    "\u0080": "Control",
    "ö": "Latin Small Letter O With Diaeresis"
  }`);
  const out = canonicalize(input);
  // Read values in textual order (Object.values would move the integer-like key "1" first).
  const values = [...out.matchAll(/:"([^"]*)"/g)].map((m) => m[1]);
  assert.deepEqual(values, [
    "Carriage Return",
    "One",
    "Control",
    "Latin Small Letter O With Diaeresis",
    "Euro Sign",
    "Emoji: Grinning Face",
    "Hebrew Letter Dalet With Dagesh",
  ]);
  assert.equal(
    out,
    '{"\\r":"Carriage Return","1":"One","\u0080":"Control","ö":"Latin Small Letter O With Diaeresis","€":"Euro Sign","😀":"Emoji: Grinning Face","דּ":"Hebrew Letter Dalet With Dagesh"}',
  );
});

test("RFC 8785 appendix B: IEEE 754 number serialization", () => {
  const vectors: [number, string][] = [
    [0, "0"],
    [-0, "0"],
    [5e-324, "5e-324"],
    [1.7976931348623157e308, "1.7976931348623157e+308"],
    [9007199254740992, "9007199254740992"],
    [-9007199254740992, "-9007199254740992"],
    [295147905179352830000, "295147905179352830000"],
    [9.999999999999997e22, "9.999999999999997e+22"],
    [1e23, "1e+23"],
    [1e21, "1e+21"],
    [999999999999999700000, "999999999999999700000"],
    [0.000001, "0.000001"],
    [1e-7, "1e-7"],
  ];
  for (const [value, text] of vectors) assert.equal(canonicalize(value), text, `number ${value}`);
});

test("nested structures, whitespace and member order", () => {
  const a = { b: [1, { z: 1, a: "x" }], a: { d: null, c: true } };
  const b = JSON.parse('{ "a" : { "c" : true , "d" : null } , "b" : [ 1 , { "a" : "x" , "z" : 1 } ] }');
  assert.equal(canonicalize(a), '{"a":{"c":true,"d":null},"b":[1,{"a":"x","z":1}]}');
  assert.equal(canonicalize(a), canonicalize(b));
  assert.equal(canonicalize([]), "[]");
  assert.equal(canonicalize({}), "{}");
  assert.equal(canonicalize("café"), '"café"');
});

test("undefined members are skipped, like JSON.stringify", () => {
  assert.equal(canonicalize({ a: 1, b: undefined }), '{"a":1}');
  assert.equal(canonicalize(Object.create(null, { x: { value: 1, enumerable: true } })), '{"x":1}');
});

test("errors: values JSON cannot represent are rejected, never coerced", () => {
  const bad: [unknown, RegExp][] = [
    [Number.NaN, /non-finite number/],
    [Number.POSITIVE_INFINITY, /non-finite number/],
    [{ a: [1, Number.NEGATIVE_INFINITY] }, /a\[1\]: non-finite number/],
    ["\ud800", /lone surrogate/],
    [{ k: "x\udc00y" }, /k: string contains a lone surrogate/],
    [{ "\ud800": 1 }, /member name contains a lone surrogate/],
    [[1, undefined], /undefined array element/],
    [[1, , 3], /\[1\]: undefined array element/], // sparse: map() would skip the hole and emit "[1,,3]", which is not JSON
    [Array(2), /\[0\]: undefined array element/],
    [10n, /cannot canonicalize a bigint/],
    [() => 1, /cannot canonicalize a function/],
    [Symbol("s"), /cannot canonicalize a symbol/],
    [undefined, /cannot canonicalize a undefined/],
    [new Date(0), /only plain objects/],
    [new Map(), /only plain objects/],
    [{ nested: { when: new Uint8Array(1) } }, /nested\.when: only plain objects/],
  ];
  for (const [value, message] of bad) {
    assert.throws(() => canonicalize(value), (error: unknown) => error instanceof CanonicalizationError && message.test((error as Error).message), String(message));
  }
});
