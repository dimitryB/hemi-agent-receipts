import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildMerkleTree,
  DEPLOYMENTS,
  leafHash,
  parseReceiptFile,
  verify,
  VERIFY_CHECKS,
  type ReceiptFile,
  type StatusInfo,
  type VerifyProblem,
  type VerifyResult,
} from "@hemi-receipts/sdk";
import { createPublicClient, custom, type Hex } from "viem";
import {
  ago,
  agreesLocally,
  CHECK_TEXT,
  checkToneOf,
  duration,
  ladderOf,
  listWords,
  networkName,
  plainBitcoin,
  plainProblem,
  proofPath,
  proofWords,
  runView,
  scaleDecimal,
  short,
  showProgress,
  spendLabel,
  usesOfficialTrust,
  utc,
  verdictOf,
} from "../src/present.js";

const raw = (name: string): unknown => JSON.parse(readFileSync(new URL(`../samples/${name}`, import.meta.url), "utf8"));

const sample = (name: string): ReceiptFile => {
  const parsed = parseReceiptFile(raw(name));
  assert.ok(parsed.ok);
  return parsed.file;
};

/** verify() as the page runs it when it cannot reach the network: every request fails at once.
 *  Like the page, it trusts the built-in registry of the receipt's own chain (testnet when unsure). */
const offlineVerify = (input: unknown): Promise<VerifyResult> =>
  verify(input, {
    registry: (DEPLOYMENTS[(input as { chainId?: number }).chainId ?? 743_111] ?? DEPLOYMENTS[743_111]!).registry,
    client: createPublicClient({ transport: custom({ request: async () => Promise.reject(new Error("offline")) }, { retryCount: 0 }) }),
  });

const offline = (name: string): Promise<VerifyResult> => offlineVerify(raw(name));

const allPass = Object.fromEntries(VERIFY_CHECKS.map((c) => [c, "pass"])) as VerifyResult["checks"];

function result(over: Partial<VerifyResult> = {}): VerifyResult {
  return { valid: true, status: null, batchTx: null, leaf: null, reasons: [], problems: [], checks: allPass, signer: null, incomplete: false, ...over };
}

const confirmedTestnet: StatusInfo = {
  stage: "hemi-confirmed",
  estimated: false,
  checkedAt: 1_793_329_000,
  hemi: { blockNumber: 7_101_229, blockTimestamp: 1_793_325_000, latestBlock: 7_101_520, confirmations: 292, requiredConfirmations: 10, safeBlock: 7_101_510 },
  btc: { source: "unavailable", popLive: false, detail: "no PoP activity: no PoP payout in 18 keystone blocks sampled over the last 6 h (blocks 1…2)" },
};

describe("formatting", () => {
  test("short, duration, ago", () => {
    assert.equal(short("0x4c942e2c9ce38ba8073e9d3fb5f4c2041e3a4e19", 6), "0x4c942e…3a4e19");
    assert.equal(short("0x1234", 6), "0x1234");
    assert.equal(duration(42), "42 s");
    assert.equal(duration(111), "1 min 51 s");
    assert.equal(duration(3600), "1 h");
    assert.equal(duration(3725), "1 h 2 min");
    assert.equal(ago(1000, 1030), "just now");
    assert.equal(ago(1000, 1000 + 3600), "1 hour ago");
    assert.equal(ago(1000, 1000 + 7200), "2 hours ago");
    assert.equal(ago(1000, 1000 + 60 * 5), "5 minutes ago");
    assert.equal(listWords(["a"]), "a");
    assert.equal(listWords(["a", "b", "c"]), "a, b and c");
  });

  test("a time outside the calendar is called unreadable; it must not stop the page", () => {
    assert.equal(utc(1_793_388_687), "2026-10-30 19:31:27 UTC");
    assert.match(utc(Number.MAX_SAFE_INTEGER), /unreadable/);
    assert.match(utc(253_402_300_800), /unreadable/, "the year 10000 does not fit the format");
  });

  test("decimal scaling keeps every digit and never invents one", () => {
    assert.equal(scaleDecimal("1000", 6), "0.001");
    assert.equal(scaleDecimal("1", 8), "0.00000001");
    assert.equal(scaleDecimal("123456789", 6), "123.456789");
    assert.equal(scaleDecimal("1000000", 6), "1");
    assert.equal(scaleDecimal("0", 6), "0");
    assert.equal(scaleDecimal("1.5", 1), "0.15");
    // fractional base units: a zero integer part is not a digit, and the fraction keeps its position
    assert.equal(scaleDecimal("0.1", 6), "0.0000001");
    assert.equal(scaleDecimal("0.05", 6), "0.00000005");
    assert.equal(scaleDecimal("10", 6), "0.00001");
    assert.equal(scaleDecimal("007", 2), "0.07");
  });

  test("spend labels: known Hemi assets in display units, USD, unknown left as written", () => {
    assert.deepEqual(spendLabel("eip155:743111/erc20:0xD47971C7F5B1067d25cd45d30b2c9eb60de96443", "1000"), { amount: "0.001 USDC.e", asset: "USDC.e on Hemi testnet" });
    assert.deepEqual(spendLabel("eip155:43111/erc20:0xaa40c0c7644e0b2b224509571e10ad20d9c4ef28", "2500"), { amount: "0.000025 hemiBTC", asset: "hemiBTC on Hemi" });
    assert.deepEqual(spendLabel("usd", "0.0042"), { amount: "$0.0042", asset: "US dollars" });
    assert.equal(spendLabel("gpu-seconds", "12").note, "unknown asset: amount shown as written");
  });
});

describe("the run", () => {
  test("a real testnet manifest reads as who, when, tools and spend", () => {
    const v = runView(sample("genuine.receipt.json").manifest!);
    assert.equal(v.model, "claude-fable-5-1");
    assert.equal(v.took, "1 min 51 s");
    assert.equal(v.toolCalls.length, 4);
    assert.equal(v.toolCalls[0]!.offset, "+3 s");
    assert.equal(v.actsForItself, false);
    assert.equal(v.spend[0]!.amount, "0.001 USDC.e");
  });
});

describe("the run, with odd values the format allows", () => {
  test("an out-of-range start time still reads", () => {
    const manifest = { ...sample("genuine.receipt.json").manifest!, startedAt: Number.MAX_SAFE_INTEGER };
    assert.match(runView(manifest).started, /unreadable/);
  });
});

describe("verdict", () => {
  const file = sample("genuine.receipt.json");

  test("genuine, failed, incomplete and not-yet-anchored each read differently", () => {
    assert.equal(verdictOf(file, result({ signer: { address: file.receipt.agent, role: "agent", method: "ecdsa" } })).title, "This receipt is genuine");
    const bad = verdictOf(file, result({ valid: false, problems: [{ check: "manifest", code: "manifest-hash-mismatch", message: "x" }] }));
    assert.equal(bad.tone, "bad");
    assert.match(bad.summary, /changed after it was signed/);
    assert.equal(verdictOf(file, result({ valid: false, incomplete: true })).tone, "unknown");
    const pending = verdictOf(file, result({ valid: false, problems: [{ check: "anchor", code: "not-anchored", message: "x" }] }));
    assert.equal(pending.tone, "wait");
    // The file lacks an anchor; whether Hemi holds the receipt is not something it can tell.
    assert.equal(pending.title, "This copy does not say where it was recorded");
    assert.match(pending.summary, /is signed/);
    assert.doesNotMatch(`${pending.title} ${pending.summary}`, /has not been recorded|not recorded on Hemi/i);
  });

  test("a signature that does not match is not blamed on someone else: the registry or network may differ", () => {
    const text = plainProblem({ check: "agentSignature", code: "signature-mismatch", message: "x" });
    assert.match(text, /someone else signed it, or it was signed for different contents, another registry or another network/);
    assert.doesNotMatch(text, /Someone else signed this receipt/);
  });

  test("a network is named only when it is known", () => {
    assert.equal(networkName(743111), "Hemi testnet");
    assert.equal(networkName(31337), "a local test chain (31337)");
    assert.equal(networkName(1), "an unknown network (chain 1)");
  });

  test("progress is shown only for a receipt that checks out, or is merely pending", () => {
    assert.equal(showProgress(result()), true);
    assert.equal(showProgress(result({ valid: false, problems: [{ check: "anchor", code: "not-anchored", message: "" }] })), true);
    assert.equal(showProgress(result({ valid: false, problems: [{ check: "merkleProof", code: "proof-local-mismatch", message: "" }] })), false);
  });

  test("every failure code the SDK emits has its own plain sentence", () => {
    const codes = [...readFileSync(new URL("../../sdk/src/verify.ts", import.meta.url), "utf8").matchAll(/fail\("[a-zA-Z]+", "([a-z0-9-]+)"/g)].map((m) => m[1]!);
    assert.ok(codes.length >= 20, `found ${codes.length} codes`);
    for (const code of new Set(codes)) {
      const p: VerifyProblem = { check: "file", code, message: `RAW:${code}` };
      assert.notEqual(plainProblem(p), p.message, `no plain sentence for ${code}`);
    }
  });

  test("every check has a plain title", () => {
    for (const c of VERIFY_CHECKS) assert.ok(CHECK_TEXT[c].title.length > 10, c);
  });
});

describe("when the page cannot reach the network", () => {
  test("a genuine receipt is unconfirmed, and says which parts held", async () => {
    const file = sample("genuine.receipt.json");
    const local = await offline("genuine.receipt.json");
    assert.equal(local.incomplete, true);
    const v = verdictOf(file, local, { offline: true });
    assert.equal(v.tone, "unknown");
    assert.equal(v.title, "Not checked against Hemi");
    assert.match(v.summary, /^The signature, the record of the run and the proof check out on this page, but it could not reach Hemi testnet/);
    assert.equal(checkToneOf(local.checks.chainId, local.problems.filter((p) => p.check === "chainId")), "unknown");
  });

  test("a tampered receipt is still rejected: a definite failure needs no network", async () => {
    const local = await offline("tampered-one-byte.receipt.json");
    const v = verdictOf(sample("tampered-one-byte.receipt.json"), local, { offline: true });
    assert.equal(v.tone, "bad");
    assert.match(v.summary, /changed after it was signed/);
  });

  test("a forged signature cannot be ruled out here (it might be a contract wallet), so it stays unconfirmed", async () => {
    const v = verdictOf(sample("forged-signature.receipt.json"), await offline("forged-signature.receipt.json"), { offline: true });
    assert.equal(v.tone, "unknown");
    assert.match(v.summary, /contract wallet, which only Hemi can confirm/);
  });

  test("an unanchored receipt whose signature did not pass is not called signed", async () => {
    const unsigned = { ...(raw("genuine.receipt.json") as object), anchor: null, agentSignature: `0x${"11".repeat(65)}` };
    const parsed = parseReceiptFile(unsigned);
    assert.ok(parsed.ok);
    const v = verdictOf(parsed.file, await offlineVerify(unsigned), { offline: true });
    assert.equal(v.title, "This copy does not say where it was recorded");
    assert.doesNotMatch(v.summary, /is signed/);
    assert.match(v.summary, /signature could not be confirmed/);
  });

  test("every recorded example result agrees with that example's no-network checks, and no other", async () => {
    const recorded = JSON.parse(readFileSync(new URL("../samples/recorded.json", import.meta.url), "utf8")) as { results: Record<string, VerifyResult> };
    const index = JSON.parse(readFileSync(new URL("../samples/index.json", import.meta.url), "utf8")) as { id: string; file: string }[];
    assert.deepEqual(Object.keys(recorded.results).sort(), index.map((s) => s.id).sort());
    for (const s of index) {
      const local = await offline(s.file);
      for (const other of index) {
        assert.equal(agreesLocally(local, recorded.results[other.id]!), other.id === s.id, `${s.id} against ${other.id}'s recorded result`);
      }
    }
    assert.equal(recorded.results.mainnet!.valid, true);
    assert.equal(recorded.results.genuine!.valid, true);
    assert.equal(recorded.results.tampered!.valid, false);
  });
});

describe("finality ladder", () => {
  test("testnet: settled on Hemi, Bitcoin steps blocked with one reason, not repeated", () => {
    const steps = ladderOf(confirmedTestnet, 743_111);
    assert.deepEqual(steps.map((s) => s.state), ["done", "done", "current", "blocked", "blocked"]);
    assert.match(steps[2]!.detail, /292 Hemi blocks on top \(10 needed\), and past Hemi's safe point/);
    assert.match(steps[3]!.detail, /Hemi testnet is not publishing its checkpoints to Bitcoin/);
    assert.equal(steps[4]!.detail, "Needs the step above first.");
  });

  test("a block above Hemi's safe head is not called past it", () => {
    const status: StatusInfo = { ...confirmedTestnet, stage: "hemi-included", hemi: { ...confirmedTestnet.hemi!, confirmations: 3, safeBlock: confirmedTestnet.hemi!.blockNumber - 1 } };
    assert.match(ladderOf(status, 743_111)[2]!.detail, /3 Hemi blocks on top \(10 needed\), and not yet past Hemi's safe point/);
  });

  test("mainnet: published and final from Bitcoin data, inheritance explained", () => {
    const status: StatusInfo = {
      ...confirmedTestnet,
      stage: "btc-final",
      btc: { source: "bitcoin", publishedAtBtcHeight: 973_739, btcConfirmations: 17, viaKeystone: 5_619_825, inherited: true, coveringKeystone: 5_619_625 },
    };
    const steps = ladderOf(status, 43_111);
    assert.deepEqual(steps.map((s) => s.state), ["done", "done", "done", "done", "done"]);
    assert.match(steps[3]!.detail, /Bitcoin block 973739 through a later checkpoint \(5619825\)/);
    assert.match(steps[4]!.detail, /17 blocks on top of that checkpoint\. 9 are needed, so this is final/);
    assert.equal(plainBitcoin(status, 43_111)!.tone, "good");
  });

  test("an estimate is labelled as one and never marks a step done", () => {
    const status: StatusInfo = { ...confirmedTestnet, btc: { source: "estimate", popLive: true, estimatedPublishedAt: 1_793_330_000, estimatedFinalAt: 1_793_335_000 } };
    const steps = ladderOf(status, 43_111);
    assert.deepEqual(steps.map((s) => s.state), ["done", "done", "current", "todo", "todo"]);
    assert.match(steps[3]!.detail, /an estimate/);
  });

  test("a voided batch reaches no stage", () => {
    const steps = ladderOf({ ...confirmedTestnet, stage: "voided" }, 743_111);
    assert.ok(steps.every((s) => s.state !== "done" && s.state !== "current"));
  });
});

describe("the page's trust settings", () => {
  const { registry } = DEPLOYMENTS[743_111]!;
  const rpc = "https://testnet.rpc.hemi.network/rpc";

  test("only the built-in registry and network address count as official", () => {
    assert.equal(usesOfficialTrust(743_111, registry, rpc), true);
    assert.equal(usesOfficialTrust(743_111, registry.toLowerCase(), rpc), true);
    assert.equal(usesOfficialTrust(743_111, `0x${"11".repeat(20)}`, rpc), false);
    assert.equal(usesOfficialTrust(743_111, registry, "http://127.0.0.1:8545"), false);
    assert.equal(usesOfficialTrust(31_337, registry, rpc), false);
  });
});

describe("a receipt that is merely pending", () => {
  test("its anchor check waits; it has not failed", () => {
    assert.equal(checkToneOf("fail", [{ check: "anchor", code: "not-anchored", message: "x" }]), "wait");
  });
});

describe("the stylesheet", () => {
  test("hidden means hidden: a failed load hides the last verdict, and .results sets its own display", () => {
    const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
    assert.match(css, /\[hidden\] \{ display: none !important; \}/);
  });

  test("text from the receipt wraps instead of widening the page (tool names, amounts)", () => {
    const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
    assert.match(css, /\.timeline \.tool \{[^}]*overflow-wrap: anywhere/);
    assert.match(css, /\.spend td \{[^}]*overflow-wrap: anywhere/);
    assert.doesNotMatch(css, /\.spend \.num \{[^}]*white-space: nowrap/);
  });
});

describe("what the proof section may state as fact", () => {
  test("what Hemi confirmed is stated as fact", () => {
    const words = proofWords(1, result());
    assert.equal(words.confirmed, true);
    assert.equal(words.root, "Batch fingerprint recorded on Hemi");
    assert.match(words.intro, /must give the batch fingerprint that Hemi recorded/);
    assert.equal(words.where, "Recorded in batch ");
  });

  test("a root Hemi did not confirm stays the receipt's own claim", () => {
    const words = proofWords(0, result({ valid: false, checks: { ...allPass, batch: "fail" } }));
    assert.equal(words.confirmed, false);
    assert.doesNotMatch(`${words.root} ${words.intro}`, /Hemi recorded|recorded on Hemi/);
    assert.equal(words.where, "The receipt says it was recorded in batch ");
  });

  test("a transaction Hemi did not confirm stays the receipt's own claim", () => {
    assert.equal(proofWords(1, result({ valid: false, checks: { ...allPass, anchorTx: "fail" } })).confirmed, false);
  });

  test("a recording the chain refuted, or a chain that moved, is not stated as fact", () => {
    assert.equal(proofWords(1, result({ valid: false, checks: { ...allPass, onchainProof: "fail" } })).confirmed, false);
    assert.equal(proofWords(1, result({ valid: false, checks: { ...allPass, status: "fail" } })).confirmed, false);
    const recorded = JSON.parse(readFileSync(new URL("../samples/recorded.json", import.meta.url), "utf8")) as { results: Record<string, VerifyResult> };
    assert.equal(proofWords(1, recorded.results["wrong-batch"]!).confirmed, false);
  });

  test("with no network nothing about the chain is stated as fact", async () => {
    assert.equal(proofWords(1, await offline("genuine.receipt.json")).confirmed, false);
  });
});

describe("proof path", () => {
  test("recomputes the SDK tree's root for every leaf", () => {
    const leaves = Array.from({ length: 7 }, (_, i) =>
      leafHash({ runId: `0x${(i + 1).toString(16).padStart(64, "0")}` as Hex, manifestHash: `0x${"ab".repeat(32)}` as Hex, agent: `0x${"11".repeat(20)}` as Hex, principal: `0x${"22".repeat(20)}` as Hex }),
    );
    const tree = buildMerkleTree(leaves);
    for (const leaf of leaves) {
      const { steps, root } = proofPath(leaf, tree.proof(leaf));
      assert.equal(root, tree.root);
      assert.equal(steps.length, tree.proof(leaf).length);
    }
  });

  test("the real testnet sample's one-step proof reaches its recorded root", () => {
    const file = sample("genuine.receipt.json");
    const leaf = leafHash(file.receipt);
    assert.equal(proofPath(leaf, file.anchor!.proof).root, file.anchor!.root.toLowerCase());
    const wrong = sample("wrong-batch.receipt.json");
    assert.notEqual(proofPath(leafHash(wrong.receipt), wrong.anchor!.proof).root, wrong.anchor!.root.toLowerCase());
  });
});
