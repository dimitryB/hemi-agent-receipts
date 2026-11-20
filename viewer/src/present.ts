/**
 * Turns a receipt file and the SDK's verify() result into plain language for a reviewer who
 * is not an engineer. Pure functions only: no DOM, no network. Every sentence here should be
 * understandable without knowing what a Merkle tree or an RPC is; the technical detail stays
 * available one click away in the page.
 */
import {
  DEPLOYMENTS,
  hashPair,
  HEMI_NETWORKS,
  STAGES,
  type ManifestV1,
  type ReceiptFile,
  type SpendCheck,
  type Stage,
  type StatusInfo,
  type VerifyCheck,
  type VerifyProblem,
  type VerifyResult,
} from "@hemi-receipts/sdk";
import type { Hex } from "viem";

export type Tone = "good" | "bad" | "wait" | "unknown";

/* ------------------------------------------------------------------ formatting helpers */

/** 0x1234…abcd: enough to compare by eye, short enough to read. */
export function short(hex: string, keep = 4): string {
  if (!hex.startsWith("0x") || hex.length <= 2 + keep * 2 + 1) return hex;
  return `${hex.slice(0, 2 + keep)}…${hex.slice(-keep)}`;
}

export function utc(unixSeconds: number): string {
  const date = new Date(unixSeconds * 1000);
  if (Number.isNaN(date.getTime()) || date.getUTCFullYear() > 9999) return `an unreadable time (${unixSeconds})`;
  return `${date.toISOString().slice(0, 19).replace("T", " ")} UTC`;
}

export function duration(seconds: number): string {
  if (seconds < 0) return "0 s";
  if (seconds < 60) return `${seconds} s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m < 60) return s ? `${m} min ${s} s` : `${m} min`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return mm ? `${h} h ${mm} min` : `${h} h`;
}

/** "a", "a and b", "a, b and c". */
export function listWords(items: readonly string[]): string {
  return items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/** "3 minutes ago", for a reviewer reading the page now. */
export function ago(unixSeconds: number, now = Math.floor(Date.now() / 1000)): string {
  const d = now - unixSeconds;
  if (d < 0) return "in the future";
  const n = (value: number, unit: string) => `${value} ${unit}${value === 1 ? "" : "s"} ago`;
  if (d < 90) return "just now";
  if (d < 3600) return n(Math.round(d / 60), "minute");
  if (d < 2 * 86400) return n(Math.round(d / 3600), "hour");
  return n(Math.round(d / 86400), "day");
}

/* ------------------------------------------------------------------ networks and assets */

export const NETWORK_NAMES: Record<number, string> = { 43111: "Hemi", 743111: "Hemi testnet" };
/** Chain ids that development chains (anvil, Hardhat, Ganache) use by default. */
const LOCAL_CHAIN_IDS = new Set([31337, 1337]);

/** False once the registry or network address differs from the page's own: it can then vouch for neither. */
export function usesOfficialTrust(chainId: number, registry: string, rpc: string): boolean {
  const official = DEPLOYMENTS[chainId]?.registry;
  return !!official && official.toLowerCase() === registry.toLowerCase() && (HEMI_NETWORKS[chainId]?.rpcUrls ?? []).includes(rpc);
}

export function networkName(chainId: number): string {
  return NETWORK_NAMES[chainId] ?? (LOCAL_CHAIN_IDS.has(chainId) ? `a local test chain (${chainId})` : `an unknown network (chain ${chainId})`);
}

interface KnownAsset {
  symbol: string;
  decimals: number;
  network: string;
}

/** CAIP-19 ids of the assets a spend line most often names (addresses lowercased). */
const KNOWN_ASSETS: Record<string, KnownAsset> = {
  "eip155:743111/erc20:0xd47971c7f5b1067d25cd45d30b2c9eb60de96443": { symbol: "USDC.e", decimals: 6, network: "Hemi testnet" },
  "eip155:43111/erc20:0xad11a8beb98bbf61dbb1aa0f6d6f2ecd87b35afa": { symbol: "USDC.e", decimals: 6, network: "Hemi" },
  "eip155:43111/erc20:0xaa40c0c7644e0b2b224509571e10ad20d9c4ef28": { symbol: "hemiBTC", decimals: 8, network: "Hemi" },
  "eip155:743111/erc20:0x36ab5dba83d5d470f670bc4c06d7da685d9afae7": { symbol: "hBTC", decimals: 8, network: "Hemi testnet" },
};

/**
 * Moves the decimal point of a canonical decimal string left by `decimals` places, digit by
 * digit (no floating point). "1" with 6 decimals is 0.000001; "0.1" is 0.0000001.
 */
export function scaleDecimal(amount: string, decimals: number): string {
  const [rawWhole = "", frac = ""] = amount.split(".");
  // The integer part without leading zeros; "" when it is zero, so only the fraction's digits
  // are positioned (a zero integer part must not count as a digit before the point).
  const whole = rawWhole.replace(/^0+/, "");
  const digits = whole + frac;
  const point = whole.length - decimals;
  let out: string;
  if (point <= 0) out = `0.${"0".repeat(-point)}${digits}`;
  else out = `${digits.slice(0, point)}${digits.length > point ? `.${digits.slice(point)}` : ""}`;
  out = out.includes(".") ? out.replace(/0+$/, "").replace(/\.$/, "") : out;
  return out === "" ? "0" : out;
}

/** "0.001 USDC.e on Hemi testnet", "$0.0042", or the raw values for an unknown asset. */
export function spendLabel(asset: string, amount: string): { amount: string; asset: string; note?: string } {
  const known = KNOWN_ASSETS[asset.toLowerCase()];
  if (known) return { amount: `${scaleDecimal(amount, known.decimals)} ${known.symbol}`, asset: `${known.symbol} on ${known.network}` };
  if (/^usd$/i.test(asset)) return { amount: `$${amount}`, asset: "US dollars" };
  return { amount, asset, note: "unknown asset: amount shown as written" };
}

/* ------------------------------------------------------------------ the run (manifest) */

export interface RunView {
  agent: string;
  principal: string;
  actsForItself: boolean;
  model: string;
  started: string;
  ended: string;
  took: string;
  toolCalls: { name: string; at: string; offset: string; argsHash: Hex; resultHash: Hex }[];
  spend: { amount: string; asset: string; note?: string; txHash?: Hex }[];
  tags: string[];
  parentRunId?: Hex;
}

export function runView(m: ManifestV1): RunView {
  return {
    agent: m.agent,
    principal: m.principal,
    actsForItself: m.agent.toLowerCase() === m.principal.toLowerCase(),
    model: m.model,
    started: utc(m.startedAt),
    ended: utc(m.endedAt),
    took: duration(m.endedAt - m.startedAt),
    toolCalls: m.toolCalls.map((c) => ({
      name: c.name,
      at: utc(c.at),
      offset: c.at >= m.startedAt ? `+${duration(c.at - m.startedAt)}` : `${duration(m.startedAt - c.at)} before start`,
      argsHash: c.argsHash,
      resultHash: c.resultHash,
    })),
    spend: m.spend.map((s) => ({ ...spendLabel(s.asset, s.amount), ...(s.txHash ? { txHash: s.txHash } : {}) })),
    tags: m.tags ?? [],
    ...(m.parentRunId ? { parentRunId: m.parentRunId } : {}),
  };
}

/* ------------------------------------------------------------------ the verdict */

export interface Verdict {
  tone: Tone;
  title: string;
  summary: string;
}

/** Problems that say nothing about the receipt itself: the network did not answer, changed while being read, or has not mined a payment yet. */
const TRANSIENT_CODES = new Set(["rpc-error", "anchor-reorged", "spend-tx-pending"]);

/** A problem that settles the matter whatever the network says (not a missing answer, not merely pending). */
export const isDefinite = (p: VerifyProblem): boolean => !TRANSIENT_CODES.has(p.code) && p.code !== "not-anchored";

/**
 * `offline`: the page could not reach the network at all, so only the checks it can do on its
 * own ran. A definite failure still rejects the receipt; anything else stays unconfirmed.
 */
export function verdictOf(file: ReceiptFile, result: VerifyResult, ctx: { offline?: boolean } = {}): Verdict {
  const definite = result.problems.find(isDefinite);
  if (definite && result.authentic) {
    // Signed and recorded, but a payment it lists is contradicted by the chain.
    const who = result.signer?.role === "principal" ? "the person or organisation the agent acted for" : "the agent";
    return {
      tone: "bad",
      title: "Genuine receipt, but a payment it lists is false",
      summary: `The receipt was signed by ${who}, recorded on ${networkName(file.chainId)} and has not been changed since. But ${networkName(file.chainId)} contradicts what it says was paid. ${plainProblem(definite)}`,
    };
  }
  if (definite) {
    return { tone: "bad", title: "This receipt does not check out", summary: plainProblem(definite) };
  }
  if (result.problems.some((p) => p.code === "anchor-reorged")) {
    return {
      tone: "unknown",
      title: "Hemi was reorganising while this was checked",
      summary: `${networkName(file.chainId)} replaced the block this receipt was recorded in while the checks ran, so this result does not stand. Check again in a few minutes, once the network has settled.`,
    };
  }
  if (result.problems.some((p) => p.code === "not-anchored")) {
    return {
      tone: "wait",
      // An anchor-less file is what the service hands out before the batch is recorded, but it may
      // also be a copy with its anchor removed: say what the file lacks, not what Hemi holds.
      title: "This copy does not say where it was recorded",
      summary: `${result.checks.agentSignature === "pass" ? "The receipt is signed, but this copy" : "Its signature could not be confirmed here, and this copy"} does not say which batch on Hemi holds it. Receipts come that way until their batch is recorded: fetch it again from the receipts service in a few minutes, as batches close every minute or so.`,
    };
  }
  if (result.incomplete && ctx.offline) {
    const held = [
      result.checks.agentSignature === "pass" && "the signature",
      file.manifest && result.checks.manifest === "pass" && "the record of the run",
      result.checks.merkleProof === "pass" && "the proof",
    ].filter((x): x is string => typeof x === "string");
    const opening = held.length
      ? `${listWords(held).replace(/^t/, "T")} ${held.length === 1 ? "checks" : "check"} out on this page, but it`
      : "This page";
    const signature = result.checks.agentSignature === "pass" ? "" : " The signature is not an ordinary signature by the agent; it may come from a contract wallet, which only Hemi can confirm.";
    return {
      tone: "unknown",
      title: "Not checked against Hemi",
      summary: `${opening} could not reach ${networkName(file.chainId)} to confirm that the batch is recorded there, so the receipt is not confirmed yet.${signature}`,
    };
  }
  if (result.incomplete) {
    return {
      tone: "unknown",
      title: "Could not finish checking",
      summary: `${networkName(file.chainId)} did not answer every question, so this receipt is neither confirmed nor rejected. It may still be genuine: check again in a minute.`,
    };
  }
  if (!result.valid) {
    const first = result.problems[0];
    return {
      tone: "bad",
      title: "This receipt does not check out",
      summary: first ? plainProblem(first) : "At least one check failed.",
    };
  }
  const who = result.signer?.role === "principal" ? "the person or organisation the agent acted for, not by the agent itself" : "the agent";
  const batch = file.anchor ? ` in batch ${file.anchor.batchId}` : "";
  return {
    tone: "good",
    title: "This receipt is genuine",
    summary: `It was signed by ${who}, recorded on ${networkName(file.chainId)}${batch}, and every check passed${file.manifest ? ", including that the record of the run is unchanged" : ""}.`,
  };
}

/** True when the only thing wrong is that the receipt has no anchor yet (a pending receipt). */
export function isOnlyUnanchored(result: VerifyResult): boolean {
  return result.problems.length > 0 && result.problems.every((p) => p.code === "not-anchored");
}

/** Progress toward finality only means something for a receipt that checks out, or is still pending. */
export function showProgress(result: VerifyResult): boolean {
  return result.valid || isOnlyUnanchored(result);
}

/** One plain sentence per failure, keyed by the SDK's stable problem codes. */
export function plainProblem(p: VerifyProblem): string {
  switch (p.code) {
    case "manifest-hash-mismatch":
      return "The record of the run was changed after it was signed: its fingerprint no longer matches the one that was recorded.";
    case "manifest-field-mismatch":
      return "The record of the run and the receipt disagree about which run this is or who ran it.";
    case "manifest-invalid":
      return "The record of the run is not in the agreed format, so it cannot be checked.";
    case "file-shape":
      return "This file is not a valid receipt.";
    case "signature-mismatch":
      // Checked against the registry and network in use, so a genuine receipt fails it there too.
      return "The signature does not match the agent or the person it acted for: someone else signed it, or it was signed for different contents, another registry or another network.";
    case "registry-mismatch":
      return "The receipt names a different registry from the one this page trusts.";
    case "chain-mismatch":
      return "The receipt belongs to a different network from the one being checked.";
    case "not-anchored":
      return "This copy of the receipt does not say where on Hemi it was recorded.";
    case "anchor-invalid":
      return "The part of the receipt that says where it was recorded is damaged.";
    case "proof-local-mismatch":
    case "proof-onchain-false":
    case "batch-root-mismatch":
      return "The proof does not lead to the batch the receipt names. This receipt was not part of that batch.";
    case "batch-unknown":
      return "The batch this receipt names does not exist on Hemi.";
    case "batch-voided":
      return "The registry's owner withdrew the batch this receipt is in, so it no longer counts.";
    case "batch-schema-mismatch":
      return "The receipt and its batch use different format versions.";
    case "batch-count-mismatch":
      return "The batch details in the receipt do not match the batch on Hemi.";
    case "registry-no-code":
      return "There is no registry contract at the address being checked.";
    case "anchor-tx-missing":
    case "anchor-tx-mismatch":
    case "anchor-log-mismatch":
    case "anchor-block-mismatch":
      return "The transaction the receipt names is not the one that recorded its batch on Hemi.";
    case "anchor-tx-failed":
      return "The transaction that should have recorded the batch failed.";
    case "rpc-error":
      return "The network did not answer this question.";
    case "anchor-reorged":
      return "Hemi replaced the block this receipt was recorded in while it was being checked. The result does not stand; check again in a few minutes.";
    case "spend-tx-missing":
      return "A payment the run lists never happened: the transaction it names does not exist.";
    case "spend-tx-failed":
      return "A payment the run lists failed: the transaction it names was reverted and moved nothing.";
    case "spend-transfer-missing":
      return "A payment the run lists does not match: the transaction it names did not move that amount of that asset.";
    case "spend-tx-pending":
      return "A payment the run lists has not gone through yet.";
    default:
      return p.message;
  }
}

/** What each check means to a reviewer, in the order the SDK runs them. */
export const CHECK_TEXT: Record<VerifyCheck, { title: string; skip?: string }> = {
  file: { title: "The file is a readable receipt" },
  registry: { title: "It points at the official receipts registry" },
  chainId: { title: "It was checked on the network it belongs to" },
  manifest: { title: "The record of the run matches its fingerprint", skip: "No record of the run is attached, so only its fingerprint can be checked" },
  agentSignature: { title: "It was signed by the agent, or by the person it acted for" },
  anchor: { title: "It says where it was recorded" },
  merkleProof: { title: "Its proof leads to the batch's fingerprint" },
  batch: { title: "The batch exists on Hemi and was not withdrawn" },
  onchainProof: { title: "Hemi's registry confirms the proof" },
  anchorTx: { title: "The recording transaction is the real one" },
  status: { title: "Its progress toward finality could be read" },
  spend: { title: "The payments it lists match the network", skip: "None of the payments it lists could be compared with the network" },
};

/**
 * One payment line's result, in words. Only payments can be checked this way: the tools, the
 * model, the prompt and the output stay what the signer wrote.
 */
export function spendStatus(check: SpendCheck | undefined, file: ReceiptFile): { tone: Tone; text: string } {
  const network = networkName(file.chainId);
  if (!check) return { tone: "unknown", text: "Not checked" };
  const role = check.payer === file.receipt.agent ? "the agent" : "the person it acted for";
  switch (check.outcome) {
    case "confirmed":
      return { tone: "good", text: `Paid by ${role}, confirmed on ${network}` };
    case "unattributed":
      return { tone: "unknown", text: `Paid on ${network}, but by another account (${short(check.payer ?? "")}), so not shown to be this run's` };
    case "contradicted":
      return { tone: "bad", text: /no transaction/.test(check.detail) ? `No such transaction on ${network}` : /reverted/.test(check.detail) ? "The transaction failed" : "The transaction moved a different amount or asset" };
    case "undetermined":
      return { tone: "unknown", text: /not mined/.test(check.detail) ? "Not gone through yet" : `${network} did not answer` };
    case "unchecked":
      if (!check.txHash) return { tone: "unknown", text: "No transaction named, so not checked" };
      if (!/^eip155:\d+\//.test(check.asset)) return { tone: "unknown", text: "Not an asset on a network, so not checked" };
      if (!check.asset.startsWith(`eip155:${file.chainId}/`)) return { tone: "unknown", text: "On another network, so not checked here" };
      return { tone: "unknown", text: "Could not be checked" };
  }
}

export function checkTone(outcome: "pass" | "fail" | "skip"): Tone {
  return outcome === "pass" ? "good" : outcome === "fail" ? "bad" : "unknown";
}

/** A check that failed only because the network did not answer, or changed under it, is unknown, not failed. */
export function checkToneOf(outcome: "pass" | "fail" | "skip", problems: VerifyProblem[]): Tone {
  if (outcome === "fail" && problems.length > 0 && problems.every((p) => p.code === "not-anchored")) return "wait";
  if (outcome === "fail" && problems.length > 0 && !problems.some(isDefinite) && problems.every((p) => TRANSIENT_CODES.has(p.code))) return "unknown";
  return checkTone(outcome);
}

/** The checks that need no network: they come out the same wherever and whenever they run. */
export const LOCAL_CHECKS = ["file", "registry", "manifest", "anchor", "merkleProof"] as const satisfies readonly VerifyCheck[];

/**
 * Whether a result recorded earlier against the network belongs to this receipt: same leaf,
 * same outcome for every check that needs no network, and the same signer where the signature
 * could be recovered here. Only then may a page that cannot reach the network show it.
 */
export function agreesLocally(live: VerifyResult, recorded: VerifyResult): boolean {
  if (!live.leaf || live.leaf !== recorded.leaf) return false;
  if (LOCAL_CHECKS.some((c) => live.checks[c] !== recorded.checks[c])) return false;
  if (live.checks.agentSignature === "pass") return recorded.signer?.address === live.signer?.address;
  return recorded.checks.agentSignature !== "pass" || recorded.signer?.method === "eip1271";
}

/* ------------------------------------------------------------------ the finality ladder */

export interface LadderStep {
  stage: Stage;
  label: string;
  /** "checking": the Bitcoin steps while the page is still asking Bitcoin (BITCOIN_CHECKING). */
  state: "done" | "current" | "todo" | "blocked" | "checking";
  detail: string;
}

/**
 * The `btc.detail` of a first, quick result whose Bitcoin stages are still being looked up. The
 * page shows that result at once and replaces it when the Bitcoin answer comes, which can take
 * half a minute because the public Bitcoin explorers are asked at a gentle pace.
 */
export const BITCOIN_CHECKING = "Bitcoin is still being checked";

export const STAGE_LABELS: Record<Stage, string> = {
  pending: "Submitted",
  "hemi-included": "Recorded on Hemi",
  "hemi-confirmed": "Settled on Hemi",
  "btc-published": "Published to Bitcoin",
  "btc-final": "Final on Bitcoin",
};

/** Why the Bitcoin stages cannot move, in words. */
export function plainBitcoin(status: StatusInfo | null, chainId: number): { tone: Tone; text: string } | null {
  const btc = status?.btc;
  if (!btc) return null;
  if (btc.source === "bitcoin") {
    const c = btc.btcConfirmations ?? 0;
    const via = btc.inherited ? ` (through a later checkpoint, ${btc.viaKeystone}, which also covers this one)` : "";
    return {
      tone: c >= 9 ? "good" : "wait",
      text: `Hemi's checkpoint for this block was written into Bitcoin block ${btc.publishedAtBtcHeight}${via}. Bitcoin has ${c} block${c === 1 ? "" : "s"} on top of it; 9 makes it final.`,
    };
  }
  if (btc.source === "estimate") {
    const when = btc.estimatedFinalAt ? utc(btc.estimatedFinalAt) : "later";
    return { tone: "wait", text: `Hemi is publishing to Bitcoin, but this checkpoint has not been seen there yet. Typically final by about ${when}. That is an estimate, not a fact.` };
  }
  const detail = btc.detail ?? "";
  if (detail === BITCOIN_CHECKING) {
    return { tone: "wait", text: "Checking Bitcoin now. This can take up to half a minute; everything above already stands." };
  }
  if (/^no PoP activity/.test(detail)) {
    return {
      tone: "unknown",
      text: `${networkName(chainId)} is not publishing its checkpoints to Bitcoin at the moment, so this receipt cannot become Bitcoin-final yet. Everything on Hemi itself is checked.`,
    };
  }
  if (/no Bitcoin finality source/.test(detail)) {
    return { tone: "unknown", text: "Bitcoin was not checked for this receipt." };
  }
  return { tone: "unknown", text: `Bitcoin could not be checked: ${detail}` };
}

/** The sentence under each Bitcoin step: the first says what happened or why not, the second what is left. */
function bitcoinStepText(step: "btc-published" | "btc-final", status: StatusInfo | null, chainId: number): string | undefined {
  const btc = status?.btc;
  if (!btc) return undefined;
  if (btc.source === "bitcoin") {
    const c = btc.btcConfirmations ?? 0;
    if (step === "btc-published") {
      const via = btc.inherited ? ` through a later checkpoint (${btc.viaKeystone}) that also covers this block` : "";
      return `Hemi's checkpoint for this block was written into Bitcoin block ${btc.publishedAtBtcHeight}${via}.`;
    }
    return c >= 9
      ? `Bitcoin has ${c} blocks on top of that checkpoint. 9 are needed, so this is final.`
      : `Bitcoin has ${c} block${c === 1 ? "" : "s"} on top of that checkpoint. 9 are needed.`;
  }
  if (btc.source === "estimate") {
    return step === "btc-published"
      ? `Not seen on Bitcoin yet. Usually there by about ${btc.estimatedPublishedAt ? utc(btc.estimatedPublishedAt) : "soon"} (an estimate).`
      : `Usually final by about ${btc.estimatedFinalAt ? utc(btc.estimatedFinalAt) : "later"} (an estimate).`;
  }
  return step === "btc-published" ? plainBitcoin(status, chainId)?.text : "Needs the step above first.";
}

export function ladderOf(status: StatusInfo | null, chainId: number): LadderStep[] {
  const stage = status?.stage ?? "pending";
  const reached = stage === "voided" ? -1 : STAGES.indexOf(stage as Stage);
  const btcChecking = status?.btc?.detail === BITCOIN_CHECKING;
  const btcBlocked = status?.btc?.source === "unavailable" && !btcChecking;
  const hemi = status?.hemi;
  return STAGES.map((s, i): LadderStep => {
    let state: LadderStep["state"] = i < reached ? "done" : i === reached ? "current" : "todo";
    if (i === reached && i === STAGES.length - 1) state = "done";
    if ((s === "btc-published" || s === "btc-final") && state === "todo") {
      if (btcBlocked) state = "blocked";
      else if (btcChecking) state = "checking";
    }
    let detail = "";
    switch (s) {
      case "pending":
        detail = stage === "pending" ? "This copy names no batch on Hemi yet." : "Accepted and put into a batch.";
        break;
      case "hemi-included":
        detail = hemi ? `In Hemi block ${hemi.blockNumber}, ${ago(hemi.blockTimestamp)}.` : "Not yet in a Hemi block.";
        break;
      case "hemi-confirmed":
        detail = hemi
          ? `${hemi.confirmations} Hemi block${hemi.confirmations === 1 ? "" : "s"} on top (${hemi.requiredConfirmations} needed)` +
            (hemi.safeBlock === undefined ? "." : `, and ${hemi.blockNumber <= hemi.safeBlock ? "" : "not yet "}past Hemi's safe point, where its data is posted to Ethereum.`)
          : "Needs more Hemi blocks on top.";
        break;
      case "btc-published":
      case "btc-final":
        detail = bitcoinStepText(s, status, chainId) ?? "Checked once the receipt is settled on Hemi.";
        break;
    }
    return { stage: s, label: STAGE_LABELS[s], state, detail };
  });
}

/* ------------------------------------------------------------------ the proof path */

export interface ProofWords {
  /** Hemi itself confirmed the batch and the transaction, so the page may state them as fact. */
  confirmed: boolean;
  root: string;
  intro: string;
  /** Opens the sentence naming the batch and transaction. */
  where: string;
}

/**
 * The proof section's wording. The anchor is the file's own claim until the chain has confirmed
 * it, so it is only stated as fact once every check of the chain has passed.
 */
export function proofWords(steps: number, result: VerifyResult): ProofWords {
  const confirmed = (["batch", "onchainProof", "anchorTx", "status"] as const).every((c) => result.checks[c] === "pass");
  const neighbours = `${steps} neighbour${steps === 1 ? "" : "s"}`;
  if (confirmed) {
    return {
      confirmed,
      root: "Batch fingerprint recorded on Hemi",
      intro: steps
        ? `The batch holds many receipts. Combining this receipt's fingerprint with ${neighbours} must give the batch fingerprint that Hemi recorded:`
        : "This receipt was recorded on its own, so its fingerprint is the batch fingerprint:",
      where: "Recorded in batch ",
    };
  }
  return {
    confirmed,
    root: "Batch fingerprint the receipt names",
    intro: steps
      ? `Combining this receipt's fingerprint with ${neighbours} must give the batch fingerprint the receipt names. That is not confirmed by the network:`
      : "The receipt says it was recorded on its own, so its fingerprint should be the batch fingerprint it names. That is not confirmed by the network:",
    where: "The receipt says it was recorded in batch ",
  };
}

export interface ProofStep {
  /** The value going in at this step (the leaf first). */
  node: Hex;
  /** The neighbour it is combined with. */
  sibling: Hex;
  /** keccak256 of the two, smaller first. */
  result: Hex;
}

/** Recomputes the path from a receipt's leaf to its batch root, one combination per step. */
export function proofPath(leaf: Hex, proof: readonly Hex[]): { steps: ProofStep[]; root: Hex } {
  const steps: ProofStep[] = [];
  let node = leaf.toLowerCase() as Hex;
  for (const sibling of proof) {
    const result = hashPair(node, sibling.toLowerCase() as Hex);
    steps.push({ node, sibling: sibling.toLowerCase() as Hex, result });
    node = result;
  }
  return { steps, root: node };
}
