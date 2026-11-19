# Receipt viewer

One static page that answers, for a reviewer who is not an engineer: is this record of an AI agent's run real, and how settled is it? It loads a receipt file, verifies it in the browser with the SDK's `verify()`, and shows the run beside its verdict, its progress toward Bitcoin finality, every check in plain words, and the Merkle proof step by step.

**Hosted:** https://dimitryb.github.io/hemi-agent-receipts/. On every push to `main` that touches the viewer or the SDK, [`.github/workflows/pages.yml`](../.github/workflows/pages.yml) builds both, runs the viewer tests and publishes `viewer/dist` to GitHub Pages. It is the same page as below; it holds no keys and never contacts the receipts service. All its paths are relative, so it works from a subfolder.

```bash
npm run build -w sdk && npm run build -w viewer   # bundles the SDK and viem into viewer/dist/app.js
npm run serve -w viewer                            # http://127.0.0.1:5180
```

Open a receipt by dropping a `.receipt.json` file, pasting it, or picking an example. URL parameters also work:

| URL | Loads |
|------|------|
| `/?sample=mainnet` | an example: `mainnet`, `genuine`, `private`, `tampered`, `forged`, `wrong-batch` |
| `/?receipt=<url>` | a receipt file from any URL that allows cross-origin reads |
| `/?service=<url>&runId=0x…` | a receipt from the receipts service's `GET /receipts/:runId` |

**What it trusts.** The registry address is built into the page (`DEPLOYMENTS` in the SDK) for Hemi testnet and mainnet, never taken from the receipt file. For any other chain the page asks for it. The network address (RPC) defaults to Hemi's public RPC, which allows browser requests; both can be changed under "What this page trusts". The receipts service is never asked whether a receipt is real: even a receipt loaded from the service is verified against the chain.

**Bitcoin.** On Hemi mainnet the page looks for the PoP transaction through public Bitcoin explorers (Esplora) using the known miner addresses. Scanning raw Bitcoin blocks (about 1.6 MB each) is off unless the reviewer ticks the box. On Hemi testnet it reports, in words, that the testnet is not publishing to Bitcoin (docs/DECISIONS.md D-4).

**Safety.** Everything from a receipt file is untrusted and is only placed with `textContent`, never as HTML.

**Shared page.** `npm run build:artifact -w viewer` builds a single-page version for claude.ai into `viewer/dist/artifact/`. It inlines the stylesheet and the script, and keeps the examples as files the page fetches. A page shared there cannot reach the Hemi RPC. It runs the checks that need no network and says so. For the bundled examples, it shows the result recorded against each example's network with its date (`npm run record -w viewer` refreshes `samples/recorded.json`); see docs/DECISIONS.md D-13. With no URL parameters the page opens on the mainnet example, and `#tampered`, `#forged` and the other ids pick another, also on an open page. The address keeps naming the example on screen, and drops the id when a pasted or opened file is shown instead.

**Examples** (`viewer/samples/`) are real receipts. The first is from the mainnet smoke test in `demo/mainnet-smoke-20261113T022336Z/` (registry `0x9512…5A40`, batch 1). The rest come from the live testnet run in `demo/testnet-20261030T015811Z/` (batch 6): a signed and anchored receipt, the same receipt without its run details, and its three tampered copies. That run's record lists a payment whose transaction never existed (the example trace it came from made one up), so since D-17 the testnet example shows a genuine receipt with a false payment; without its run details there is nothing to compare, and it checks out. The mainnet example lists the same made-up payment on testnet, which the page does not read for a mainnet receipt, so it shows as not checked.

**Tests.** `npm test -w viewer` covers the plain-language layer (`src/present.ts`): verdicts, the finality ladder, amounts, and one plain sentence for every failure code the SDK can emit. The page itself was checked in a browser against live testnet: all five examples, paste, `?service=`, light and dark themes, and a 375 px phone width (no horizontal scroll; the verdict comes first).
