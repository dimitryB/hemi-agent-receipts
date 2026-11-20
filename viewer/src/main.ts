/**
 * Receipt viewer. Loads a receipt file, verifies it in the browser with the SDK (Hemi RPC and,
 * on mainnet, Bitcoin data; never the receipts service), and renders it for a reviewer.
 *
 * When the page cannot reach the network at all (offline, or opened where outside connections
 * are blocked, as on a page shared through claude.ai), it runs the checks that need no network
 * and says so. For the bundled examples only, it then shows the full result recorded against
 * the network by `npm run record -w viewer`, labelled with its date.
 *
 * Everything from the file is untrusted: it is only ever placed with textContent, never as HTML.
 */
import {
  DEPLOYMENTS,
  HEMI_NETWORKS,
  defaultFinalityReader,
  explorerTxUrl,
  parseReceiptFile,
  unavailableFinality,
  verify,
  VERIFY_CHECKS,
  type FinalityReader,
  type ManifestV1,
  type ReceiptFile,
  type VerifyResult,
} from "@hemi-receipts/sdk";
import { createPublicClient, custom, type Address, type Hex } from "viem";
import {
  agreesLocally,
  BITCOIN_CHECKING,
  CHECK_TEXT,
  checkToneOf,
  ladderOf,
  networkName,
  plainBitcoin,
  plainProblem,
  proofPath,
  proofWords,
  runView,
  showProgress,
  short,
  spendStatus,
  usesOfficialTrust,
  utc,
  verdictOf,
  type Tone,
} from "./present.js";

/* ------------------------------------------------------------------ tiny DOM helpers */

type Child = Node | string | null | undefined | false;

function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") el.className = v;
    else el.setAttribute(k, v);
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function hashEl(value: string, keep = 6, title?: string): HTMLElement {
  const el = h("code", { class: "hash", title: title ?? value }, short(value, keep));
  el.addEventListener("click", () => {
    void navigator.clipboard?.writeText(value).then(() => {
      el.classList.add("copied");
      setTimeout(() => el.classList.remove("copied"), 900);
    });
  });
  return el;
}

function icon(tone: Tone): HTMLElement {
  const glyph = tone === "good" ? "✓" : tone === "bad" ? "✕" : tone === "wait" ? "…" : "?";
  const label = tone === "good" ? "passed" : tone === "bad" ? "failed" : tone === "wait" ? "in progress" : "not checked";
  return h("span", { class: `mark mark-${tone}`, role: "img", "aria-label": label }, glyph);
}

function link(href: string | undefined, text: string): HTMLElement {
  return href ? h("a", { href, target: "_blank", rel: "noopener noreferrer" }, text) : h("span", {}, text);
}

/* ------------------------------------------------------------------ state */

interface Sample {
  id: string;
  label: string;
  file: string;
}

/** samples/recorded.json: each example's verify() result, recorded against its own network. */
interface Recorded {
  recordedAt: number;
  /** The RPC each example was checked through: the examples span Hemi mainnet and testnet. */
  rpcs: Record<string, string>;
  results: Record<string, VerifyResult>;
}

/** How a result was obtained, which changes what the page may claim about it. */
type Mode = { kind: "live" } | { kind: "offline" } | { kind: "recorded"; at: number; rpc: string };

let current: { raw: unknown; file: ReceiptFile; source: string; sampleId?: string } | null = null;
let run = 0;
/** Counts file loads: only the latest may reach the page, however the answers arrive. */
let load = 0;
let recorded: Promise<Recorded | null> | null = null;

/* ------------------------------------------------------------------ loading */

async function loadSamples(): Promise<Sample[]> {
  try {
    const res = await fetch("samples/index.json");
    return res.ok ? ((await res.json()) as Sample[]) : [];
  } catch {
    return [];
  }
}

function loadRecorded(): Promise<Recorded | null> {
  recorded ??= fetch("samples/recorded.json")
    .then((res) => (res.ok ? (res.json() as Promise<Recorded>) : null))
    .catch(() => null);
  return recorded;
}

/** Keeps the address's #<id> naming the example on screen, and no example once something else is shown. */
function showHash(sampleId: string | undefined): void {
  const wanted = sampleId ? `#${sampleId}` : "";
  if (location.hash === wanted) return;
  try {
    history.replaceState(history.state, "", `${location.href.split("#")[0]}${wanted}`);
  } catch {
    // Some embedding pages refuse history calls: the page still works, only the address is stale.
  }
}

/** A file that did not load leaves nothing on screen: no verdict may outlive its receipt. */
function showLoadError(message: string): void {
  run++;
  current = null;
  $("results").hidden = true;
  const box = $("load-error");
  box.textContent = message;
  box.hidden = false;
}

async function accept(raw: unknown, source: string, sampleId?: string): Promise<void> {
  $("load-error").hidden = true;
  const parsed = parseReceiptFile(raw);
  if (!parsed.ok) {
    showLoadError(`This is not a receipt file: ${parsed.errors.join("; ")}`);
    return;
  }
  current = { raw, file: parsed.file, source, ...(sampleId ? { sampleId } : {}) };
  showHash(sampleId);
  fillSettings(parsed.file);
  renderRun(parsed.file);
  await check();
}

async function acceptText(text: string, source: string): Promise<void> {
  load++;
  $<HTMLSelectElement>("sample").value = "";
  try {
    await accept(JSON.parse(text), source);
  } catch (error) {
    showLoadError(`Could not read ${source}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function acceptUrl(url: string, source: string, sampleId?: string): Promise<void> {
  const mine = ++load;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const raw: unknown = await res.json();
    if (mine === load) await accept(raw, source, sampleId);
  } catch (error) {
    if (mine === load) showLoadError(`Could not load ${source}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/* ------------------------------------------------------------------ settings */

function fillSettings(file: ReceiptFile): void {
  const deployment = DEPLOYMENTS[file.chainId];
  const network = HEMI_NETWORKS[file.chainId];
  const registry = $<HTMLInputElement>("registry");
  const rpc = $<HTMLInputElement>("rpc");
  registry.value = deployment?.registry ?? "";
  registry.placeholder = deployment ? "" : "0x… (no official registry is known for this network)";
  rpc.value = network?.rpcUrls[0] ?? "";
  rpc.placeholder = network ? "" : "http://127.0.0.1:8545";
  describeRegistry(file.chainId, registry.value);
  $("scan-row").hidden = file.chainId !== 43111;
  if (!deployment || !network) $<HTMLDetailsElement>("settings").open = true;
}

function describeRegistry(chainId: number, registry: string): void {
  const official = DEPLOYMENTS[chainId]?.registry;
  $("registry-source").textContent = !official
    ? `No official registry is known for ${networkName(chainId)}. Enter the address you trust; the one written in the receipt is not used on its own.`
    : official.toLowerCase() === registry.toLowerCase()
      ? `The official registry for ${networkName(chainId)}, built into this page. The address written in the receipt is never trusted on its own.`
      : `You changed this. The official registry for ${networkName(chainId)} is ${official}.`;
}

/* ------------------------------------------------------------------ verification */

async function check(): Promise<void> {
  if (!current) return;
  const mine = ++run;
  const { file, raw, sampleId } = current;
  const registry = $<HTMLInputElement>("registry").value.trim();
  const rpc = $<HTMLInputElement>("rpc").value.trim();
  describeRegistry(file.chainId, registry);
  $("results").hidden = false;
  renderChecking(file);
  if (!/^0x[0-9a-fA-F]{40}$/.test(registry) || !rpc) {
    renderVerdict({ tone: "unknown", title: "Tell the page what to trust", summary: "Enter the registry address and a network address (RPC) in the settings below, then check again." });
    return;
  }
  if (!(await reachable(rpc))) {
    // No network at all: run what needs none, then prefer a matching recorded result.
    const local = await verify(raw, { registry: registry as Address, client: unreachableClient() });
    const saved = sampleId ? await loadRecorded() : null;
    if (mine !== run) return;
    const match = sampleId && saved ? saved.results[sampleId] : undefined;
    const savedRpc = sampleId && saved ? saved.rpcs?.[sampleId] : undefined;
    if (saved && match && savedRpc && agreesLocally(local, match)) {
      renderResult(file, match, registry as Address, savedRpc, { kind: "recorded", at: saved.recordedAt, rpc });
    } else renderResult(file, local, registry as Address, rpc, { kind: "offline" });
    return;
  }
  const scan = $<HTMLInputElement>("scan").checked;
  const finality = defaultFinalityReader(file.chainId, file.chainId === 43111 ? { scanMaxBlocks: scan ? 36 : 0 } : {});
  const verifyWith = (reader: FinalityReader) =>
    verify(raw, { registry: registry as Address, rpcUrls: [rpc], finality: reader, clientOptions: { retryCount: 4, timeoutMs: 15_000 } });
  // Bitcoin answers slowly (the public explorers are asked at a gentle pace, so up to half a
  // minute on mainnet). First show everything Hemi answers, with the Bitcoin steps marked as
  // being checked; then check again with Bitcoin and replace it. The second result is the one
  // that stands, verdict included.
  const twoSteps = finality !== unavailableFinality;
  let result: VerifyResult;
  try {
    result = await verifyWith(twoSteps ? bitcoinLater : finality);
    if (mine !== run) return;
    if (twoSteps && result.status?.btc?.detail === BITCOIN_CHECKING) {
      renderResult(file, result, registry as Address, rpc, { kind: "live" });
      result = await verifyWith(finality);
    }
  } catch (error) {
    if (mine !== run) return;
    renderVerdict({ tone: "unknown", title: "Could not finish checking", summary: error instanceof Error ? error.message : String(error) });
    return;
  }
  if (mine !== run) return;
  // Redrawing must not shut a box the reader opened while Bitcoin was being checked.
  const sections = ["ladder", "checks", "proof", "tech"];
  const opened = sections.map((id) => [...$(id).querySelectorAll("details")].map((d) => d.open));
  renderResult(file, result, registry as Address, rpc, { kind: "live" });
  sections.forEach((id, i) => $(id).querySelectorAll("details").forEach((d, j) => { if (opened[i]![j]) d.open = true; }));
}

/** Answers at once that Bitcoin is still being checked, for the first, quick result. */
const bitcoinLater: FinalityReader = {
  async read() {
    return { source: "unavailable", detail: BITCOIN_CHECKING };
  },
};

/** One eth_chainId request: any HTTP answer means the network can be reached from this page. */
async function reachable(rpc: string): Promise<boolean> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 8_000);
  try {
    await fetch(rpc, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      signal: abort.signal,
    });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** A client whose every request fails at once, so verify() runs only its no-network checks. */
function unreachableClient() {
  return createPublicClient({
    transport: custom({ request: async () => Promise.reject(new Error("this page could not reach the network")) }, { retryCount: 0 }),
  });
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/* ------------------------------------------------------------------ rendering: the run */

function row(label: string, ...value: Child[]): HTMLElement {
  return h("div", { class: "row" }, h("dt", {}, label), h("dd", {}, ...value));
}

function renderRun(file: ReceiptFile): void {
  const box = $("run");
  box.replaceChildren();
  const r = file.receipt;
  const m = file.manifest;
  $("run-subtitle").textContent = m ? "What the receipt says the agent did. The checks show whether that holds." : "Only the run's fingerprint was shared, not its details.";

  const who = h("dl", { class: "facts" },
    row("Agent", hashEl(r.agent, 6), " ", h("span", { class: "muted" }, "the AI agent's account")),
    row("Acting for", r.principal.toLowerCase() === r.agent.toLowerCase() ? h("span", {}, "itself") : hashEl(r.principal, 6)),
    row("Run id", hashEl(r.runId, 6)),
    row("Network", networkName(file.chainId)),
  );
  box.append(h("section", { class: "block" }, h("h3", {}, "Who"), who));

  if (!m) {
    box.append(
      h("section", { class: "block" },
        h("p", { class: "muted" }, "The run's details were kept private. This file holds only their fingerprint:"),
        h("dl", { class: "facts" }, row("Fingerprint", hashEl(r.manifestHash, 8))),
      ),
    );
    return;
  }

  // The details come straight from the file and may be malformed: that must never stop the check.
  try {
    box.append(...runSections(file, m));
  } catch {
    box.append(h("section", { class: "block" }, h("p", { class: "muted" }, "The record of the run cannot be shown: it is not in the agreed format. The checks decide whether this receipt holds.")));
  }
}

function runSections(file: ReceiptFile, m: ManifestV1): HTMLElement[] {
  const sections: HTMLElement[] = [];
  const v = runView(m);
  sections.push(
    h("section", { class: "block" },
      h("h3", {}, "When and how"),
      h("dl", { class: "facts" },
        row("Model", h("strong", {}, v.model)),
        row("Started", v.started),
        row("Finished", v.ended),
        row("Took", v.took),
      ),
    ),
  );

  const calls = h("ol", { class: "timeline" });
  for (const c of v.toolCalls) {
    calls.append(
      h("li", {},
        h("span", { class: "t" }, v.toolCalls.length ? c.offset : ""),
        h("span", { class: "tool" }, c.name),
        h("span", { class: "muted small" }, "input ", hashEl(c.argsHash, 4), " · result ", hashEl(c.resultHash, 4)),
      ),
    );
  }
  sections.push(
    h("section", { class: "block" },
      h("h3", {}, `Tools it used (${v.toolCalls.length})`),
      v.toolCalls.length ? calls : h("p", { class: "muted" }, "No tool calls."),
      v.toolCalls.length ? h("p", { class: "muted small" }, "Inputs and results are recorded as fingerprints, so their contents stay private but cannot be swapped later.") : null,
    ),
  );

  const spend = h("table", { class: "spend" }, h("thead", {}, h("tr", {}, h("th", {}, "Amount"), h("th", {}, "Paid in"), h("th", {}, "Payment"), h("th", {}, "On the network"))));
  const body = h("tbody", {});
  v.spend.forEach((s, i) => {
    const tx = s.txHash ? link(explorerTxUrl(file.chainId, s.txHash), short(s.txHash, 4)) : h("span", { class: "muted" }, "—");
    // Filled in by renderSpendChecks once the network has been asked.
    const status = h("td", { "data-spend": String(i), class: "spend-unknown" }, "Checking…");
    body.append(h("tr", {}, h("td", { class: "num" }, s.amount), h("td", {}, s.asset, s.note ? h("span", { class: "muted small" }, ` (${s.note})`) : null), h("td", {}, tx), status));
  });
  spend.append(body);
  sections.push(
    h("section", { class: "block" },
      h("h3", {}, "What it spent"),
      v.spend.length ? spend : h("p", { class: "muted" }, "Nothing."),
      v.spend.length ? h("p", { class: "muted small" }, "A payment that names a transaction on this receipt's network is compared with that transaction. Everything else in the record is what the signer wrote.") : null,
    ),
  );

  const extras: HTMLElement[] = [];
  if (v.tags.length) extras.push(row("Tags", ...v.tags.map((t) => h("span", { class: "tag" }, t))));
  if (v.parentRunId) extras.push(row("Continues run", hashEl(v.parentRunId, 6)));
  extras.push(row("Prompt", hashEl(m.promptHash, 4), " ", h("span", { class: "muted small" }, "fingerprint")));
  extras.push(row("Output", hashEl(m.outputHash, 4), " ", h("span", { class: "muted small" }, "fingerprint")));
  sections.push(h("section", { class: "block" }, h("h3", {}, "Also recorded"), h("dl", { class: "facts" }, ...extras)));
  return sections;
}

/* ------------------------------------------------------------------ rendering: the verdict */

function renderVerdict(v: { tone: Tone; title: string; summary: string }): void {
  const box = $("verdict");
  box.className = `verdict verdict-${v.tone}`;
  box.replaceChildren(icon(v.tone), h("div", {}, h("h2", {}, v.title), h("p", {}, v.summary)));
}

function renderNotice(text: string | null): void {
  const box = $("notice");
  box.textContent = text ?? "";
  box.hidden = text === null;
}

function renderChecking(file: ReceiptFile): void {
  renderNotice(null);
  renderVerdict({ tone: "wait", title: "Checking…", summary: `Asking ${networkName(file.chainId)} directly. The receipts service is not involved.` });
  for (const id of ["ladder", "checks", "proof", "tech"]) $(id).replaceChildren();
}

function renderResult(file: ReceiptFile, result: VerifyResult, registry: Address, rpc: string, mode: Mode): void {
  // A live check renders twice (first without Bitcoin, then with it): start from empty sections.
  for (const id of ["ladder", "checks", "proof", "tech"]) $(id).replaceChildren();
  const offline = mode.kind === "offline";
  const network = networkName(file.chainId);
  const verdict = verdictOf(file, result, { offline });
  renderVerdict(verdict);
  if (mode.kind === "recorded") {
    renderNotice(`Recorded result. This page could not reach ${network} (${hostOf(mode.rpc)}), so for this example it shows the full check as it ran against the network on ${utc(mode.at)}. The checks that need no network ran again just now and agree.`);
  } else if (!offline && !usesOfficialTrust(file.chainId, registry, rpc) && DEPLOYMENTS[file.chainId]) {
    renderNotice("You changed the registry or network address in the settings, so this result is only as good as what you entered.");
  } else if (offline) {
    renderNotice(`This page could not reach ${network} (${hostOf(rpc)}), so it ran only the checks that need no network. It may be offline, or opened somewhere that blocks outside connections, such as a page shared through claude.ai. To finish the check, open the viewer on your own computer or run "receipts verify" on this file.`);
  }

  // Any further problems, in plain words (the summary and repeats dropped; when the network
  // could not be reached at all, the notice already says so once).
  const shown = result.problems.filter((p) => !(offline && p.code === "rpc-error") && !(verdict.tone === "wait" && p.code === "not-anchored"));
  const plain = [...new Set(shown.map(plainProblem))].filter((text) => !verdict.summary.includes(text));
  if (plain.length) {
    const list = h("ul", { class: "problems" });
    for (const text of plain) list.append(h("li", {}, text));
    $("verdict").append(h("p", {}, "Also:"), list);
  }

  // The finality ladder, only for a receipt that checks out (or is still pending).
  const ladder = $("ladder");
  if (!showProgress(result)) {
    ladder.append(
      h("h3", {}, "How settled it is"),
      h("p", { class: "muted" }, offline
        ? `Not shown: this page could not reach ${network}.`
        : result.incomplete
          ? "Not shown: the checks could not finish."
          : "Not shown: progress toward finality only means something for a receipt that checks out."),
    );
  } else renderLadder(ladder, file, result);
  renderChecksAndProof(file, result, registry, rpc, mode);
  renderSpendChecks(file, result, mode);
}

function renderLadder(ladder: HTMLElement, file: ReceiptFile, result: VerifyResult): void {
  const steps = ladderOf(result.status, file.chainId);
  const ol = h("ol", { class: "ladder" });
  for (const s of steps) {
    ol.append(
      h("li", { class: `step step-${s.state}` },
        h("span", { class: "dot", "aria-hidden": "true" }, s.state === "done" || s.state === "current" ? "●" : s.state === "blocked" ? "⊘" : s.state === "checking" ? "◌" : "○"),
        h("div", {},
          h("strong", {}, s.label),
          h("span", { class: "sr-only" }, ` (${s.state === "current" ? "reached" : s.state === "blocked" ? "not reachable now" : s.state === "checking" ? "being checked" : s.state})`),
          h("p", {}, s.detail),
        ),
      ),
    );
  }
  const stage = result.status?.stage;
  const voided = stage === "voided" ? h("p", { class: "warn" }, "The registry's owner withdrew this receipt's batch.") : null;
  ladder.append(h("h3", {}, "How settled it is"));
  if (voided) ladder.append(voided);
  ladder.append(ol);
  const btc = plainBitcoin(result.status, file.chainId);
  if (btc && btc.tone === "unknown" && result.status?.btc?.detail) {
    ladder.append(h("details", { class: "more" }, h("summary", {}, "Why, in technical terms"), h("p", { class: "mono small" }, result.status.btc.detail)));
  }
}

/** The "On the network" column of the spend table, from verify's per-payment results. */
function renderSpendChecks(file: ReceiptFile, result: VerifyResult, mode: Mode): void {
  for (const cell of document.querySelectorAll<HTMLElement>("[data-spend]")) {
    const check = result.spend?.find((s) => s.index === Number(cell.dataset.spend));
    const status = mode.kind === "offline" && !check ? { tone: "unknown" as Tone, text: "Needs the network" } : spendStatus(check, file);
    cell.className = `spend-${status.tone}`;
    cell.textContent = status.text;
    if (check) cell.title = check.detail;
  }
}

function renderChecksAndProof(file: ReceiptFile, result: VerifyResult, registry: Address, rpc: string, mode: Mode): void {
  const offline = mode.kind === "offline";
  const officialRegistry = DEPLOYMENTS[file.chainId]?.registry.toLowerCase() === registry.toLowerCase();
  // The checks.
  const checks = h("ul", { class: "checks" });
  for (const name of VERIFY_CHECKS) {
    const outcome = result.checks[name];
    const text = CHECK_TEXT[name];
    const problems = result.problems.filter((p) => p.check === name);
    const tone = checkToneOf(outcome, problems);
    const why = problems.filter((p) => !(offline && p.code === "rpc-error"));
    checks.append(
      h("li", { class: `check check-${tone}` },
        icon(tone),
        h("div", {},
          h("span", {}, outcome === "skip" && text.skip ? text.skip : name === "registry" && !officialRegistry ? "It points at the registry entered in the settings" : text.title),
          ...why.map((p) => h("p", { class: "why" }, plainProblem(p), h("span", { class: "mono small muted" }, ` ${p.message}`))),
        ),
      ),
    );
  }
  $("checks").append(h("h3", {}, "What was checked"), checks);
  if (offline) $("checks").append(h("p", { class: "muted small" }, `A question mark is a check that needs ${networkName(file.chainId)}, which this page could not reach.`));

  // The proof path.
  if (file.anchor && result.leaf) {
    const { steps, root } = proofPath(result.leaf, file.anchor.proof);
    const matches = root === file.anchor.root.toLowerCase();
    const words = proofWords(file.anchor.proof.length, result);
    const path = h("ol", { class: "path" });
    path.append(h("li", {}, h("span", { class: "muted" }, "This receipt's fingerprint"), " ", hashEl(result.leaf, 6)));
    steps.forEach((s, i) => path.append(h("li", {}, h("span", { class: "muted" }, `combined with neighbour ${i + 1}`), " ", hashEl(s.sibling, 6), h("span", { class: "muted" }, " gives "), hashEl(s.result, 6))));
    path.append(
      h("li", { class: !matches ? "bad" : words.confirmed ? "ok" : "" },
        h("span", { class: "muted" }, words.root), " ", hashEl(file.anchor.root, 6), " ",
        icon(!matches ? "bad" : words.confirmed ? "good" : "unknown"),
      ),
    );
    const tx = words.confirmed ? (result.batchTx ?? file.anchor.txHash) : file.anchor.txHash;
    $("proof").append(
      h("h3", {}, "The proof"),
      h("p", {}, words.intro),
      path,
      h("p", {}, words.where, h("strong", {}, String(file.anchor.batchId)), " by transaction ", link(explorerTxUrl(file.chainId, tx), short(tx, 6)), ` in Hemi block ${file.anchor.blockNumber}.`),
    );
  }

  // Technical details for the curious.
  const checkedAt = mode.kind === "recorded" ? mode.at : (result.status?.checkedAt ?? Math.floor(Date.now() / 1000));
  const tech = h("dl", { class: "facts" },
    row("Checked at", `${utc(checkedAt)}${mode.kind === "recorded" ? " (recorded)" : offline ? " (no network)" : ""}`),
    row("Network", `${networkName(file.chainId)} (chain ${file.chainId})`),
    row("Registry trusted", hashEl(registry, 6)),
    row("Network address", h("span", { class: "mono small" }, rpc)),
    row("Signed by", result.signer
      ? h("span", {}, hashEl(result.signer.address, 6), ` (${result.signer.role === "agent" ? "the agent" : "the principal, on the agent's behalf; the agent itself did not sign"}, ${result.signer.method === "ecdsa" ? "ordinary key" : "contract wallet"})`)
      : "—"),
    row("Manifest hash", hashEl(file.receipt.manifestHash, 6)),
  );
  $("tech").append(
    h("details", { class: "more" },
      h("summary", {}, "Technical details"),
      tech,
      h("pre", { class: "raw" }, JSON.stringify({ valid: result.valid, checks: result.checks, problems: result.problems, status: result.status }, null, 2)),
    ),
  );
}

/* ------------------------------------------------------------------ wiring */

function readFile(file: File): void {
  void file.text().then(
    (text) => acceptText(text, file.name),
    (error: unknown) => showLoadError(`Could not read ${file.name}: ${error instanceof Error ? error.message : String(error)}`),
  );
}

async function main(): Promise<void> {
  // theme
  const root = document.documentElement;
  try {
    const saved = localStorage.getItem("receipt-viewer-theme");
    if (saved === "light" || saved === "dark") root.dataset.theme = saved;
  } catch {
    /* storage unavailable: follow the system */
  }
  $("theme").addEventListener("click", () => {
    const dark = root.dataset.theme ? root.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
    root.dataset.theme = dark ? "light" : "dark";
    try {
      localStorage.setItem("receipt-viewer-theme", root.dataset.theme);
    } catch {
      /* ignore */
    }
  });

  // file picker and drop zone
  const input = $<HTMLInputElement>("file");
  input.addEventListener("change", () => input.files?.[0] && readFile(input.files[0]));
  const drop = $("drop");
  drop.addEventListener("dragover", (e) => {
    e.preventDefault();
    drop.classList.add("over");
  });
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop.addEventListener("drop", (e) => {
    e.preventDefault();
    drop.classList.remove("over");
    const f = e.dataTransfer?.files?.[0];
    if (f) readFile(f);
  });

  // paste
  $("paste-go").addEventListener("click", () => void acceptText($<HTMLTextAreaElement>("paste").value, "the pasted text"));

  // samples
  const samples = await loadSamples();
  const select = $<HTMLSelectElement>("sample");
  for (const s of samples) select.append(h("option", { value: s.id }, s.label));
  select.disabled = samples.length === 0;
  select.addEventListener("change", () => {
    const s = samples.find((x) => x.id === select.value);
    if (s) void acceptUrl(`samples/${s.file}`, s.label, s.id);
  });
  // #<id> picks an example when the page opens and also afterwards; accept() keeps it in step.
  window.addEventListener("hashchange", () => {
    const s = samples.find((x) => x.id === location.hash.slice(1));
    if (!s || current?.sampleId === s.id) return;
    select.value = s.id;
    void acceptUrl(`samples/${s.file}`, s.label, s.id);
  });

  // settings
  $("recheck").addEventListener("click", () => void check());

  // URL parameters: ?sample=<id>, ?receipt=<url>, or ?service=<url>&runId=<0x…>. With none,
  // open on the example named by #<id>, else the first, so the page is never an empty shell.
  const params = new URLSearchParams(location.search);
  const sample = params.get("sample");
  const receiptUrl = params.get("receipt");
  const service = params.get("service");
  const runId = params.get("runId");
  if (sample) {
    const s = samples.find((x) => x.id === sample);
    if (s) {
      select.value = s.id;
      await acceptUrl(`samples/${s.file}`, s.label, s.id);
    } else showLoadError(`No sample called "${sample}".`);
  } else if (receiptUrl) {
    await acceptUrl(receiptUrl, receiptUrl);
  } else if (service && runId) {
    await acceptUrl(`${service.replace(/\/$/, "")}/receipts/${runId}`, `the receipts service at ${service}`);
  } else {
    const s = samples.find((x) => x.id === location.hash.slice(1)) ?? samples[0];
    if (s) {
      select.value = s.id;
      await acceptUrl(`samples/${s.file}`, s.label, s.id);
    }
  }
}

void main();

export type { Hex };
