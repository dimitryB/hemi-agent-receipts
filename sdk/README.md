# @hemi-receipts/sdk

Build, sign, submit and verify Bitcoin-anchored receipts for AI agent runs on Hemi.
`docs/SCHEMA.md` defines every byte that is hashed or signed; this package implements it.

**Not on npm.** This package has not been published to the npm registry. Do not run `npm install @hemi-receipts/sdk`: it finds nothing today, and would install someone else's code if anyone ever registers the name. Build it from this repository and install the tarball instead:

```bash
npm ci && npm run build -w sdk     # in a clone of this repository
npm pack -w sdk                    # writes hemi-receipts-sdk-0.1.0.tgz
cd ../your-project && npm install ../hemi-agent-receipts/hemi-receipts-sdk-0.1.0.tgz
```

Its only dependency is `viem`, pinned exactly.

```ts
import {
  parseTraceJsonl, receiptFromManifest, registryDomain, signReceipt,
  getServiceInfo, submit, waitForReceipt, verify, DEPLOYMENTS,
} from "@hemi-receipts/sdk";
import { privateKeyToAccount } from "viem/accounts";

// 1. A manifest from a trace (or build one by hand and normalizeManifest it)
const manifest = parseTraceJsonl(traceText);               // or buildManifest(traceObject)

// 2. The agent (or its principal) signs the EIP-712 Receipt for the service's registry
const { chainId, registry } = await getServiceInfo(serviceUrl);
const receipt = receiptFromManifest(manifest);
const agentSignature = await signReceipt(privateKeyToAccount(key), receipt, registryDomain(chainId, registry));

// 3. Submit and wait for anchoring
await submit(serviceUrl, { manifest, agentSignature, store: false });   // { fetch } accepts an x402-paying fetch
const stored = await waitForReceipt(serviceUrl, manifest.runId, { until: "hemi-included" });

// 4. Anyone verifies the file with an RPC and the registry THEY trust; the service is not involved
const { status, ...file } = stored;
const result = await verify({ ...file, manifest }, { registry: DEPLOYMENTS[chainId]!.registry });
result.valid; result.reasons; result.checks; result.status?.stage;
```

## Modules

| Module | What |
|------|------|
| `canonicalize` | RFC 8785 JSON canonicalization |
| `manifest` | v1 types, `validateManifest` (strict), `normalizeManifest`, `hashManifest`, `contentHash`, `newRunId` |
| `trace` | `parseTraceJsonl(text, overrides)` (SCHEMA.md §6, errors carry line numbers), `buildManifest(trace)` |
| `receipt` | `leafHash`, EIP-712 typed data, `receiptDigest`, `signReceipt`, `recoverReceiptSigner`, `serializeReceiptTypedData` (eth_signTypedData_v4) |
| `merkle` | sorted-pair tree, OpenZeppelin `MerkleProof` compatible |
| `client` | `createHemiPublicClient`: fallback RPCs, exponential backoff, token-bucket rate limit (4 req/s) |
| `submit` | service client: `submit`, `submitDirect`, `getReceipt`, `getServiceInfo`, `waitForReceipt`; typed errors `ValidationError` (400), `PaymentRequiredError` (402, decoded x402 requirements), `NotFoundError` (404), `ConflictError` (409), `ServiceError`, `WaitError` |
| `verify` | `verify(file, { registry, rpcUrl(s) \| client, chainId?, manifest?, confirmations?, finality? })` |
| `status` | `resolveStatus`: `hemi-confirmed` = N confirmations and at or below the OP-stack safe head; Bitcoin stages only from verified data |
| `keystone` | `coveringKeystone`, `keystoneAbrev` (canonical 76-byte abbreviated keystone from 2 Hemi RPC calls), `popOpReturnScript`, `decodePopOpReturn` |
| `finality` | `EsploraClient`, `createPopFinalityReader`, `defaultFinalityReader(chainId)`, `popLiveness` |
| `chains`, `abi` | Hemi networks, known `DEPLOYMENTS`, the ReceiptRegistry ABI |

## verify

`verify` reads only the chain. The registry is the caller's trust root and is compared with
the file's, never taken from it. Each check is reported in `checks` as `pass`, `fail` or
`skip`; `valid` is true only when all pass (`manifest` may be skipped when no manifest is
given, `spend` when no entry can be compared with the chain). `reasons` say exactly what failed, e.g. `manifest hash mismatch: …`, `proof does not
verify against batch 3's root …`, `agent signature recovers to 0x…, expected agent 0x… or
principal 0x…`. RPC failures after retries set `incomplete: true`, unless another problem already rules the receipt out, rather than claiming the
receipt is invalid.

| Check | Passes when |
|------|------|
| `file` | the file is a well-formed `hemi-agent-receipt` v1 |
| `registry` | the caller's registry equals the file's (case-insensitive) |
| `chainId` | the RPC serves the file's chain (and the caller's `chainId`, if given) |
| `manifest` | the manifest validates, hashes to `manifestHash`, and its runId/agent/principal/version match |
| `agentSignature` | the EIP-712 Receipt signature recovers to agent or principal, or a contract wallet accepts it (EIP-1271/6492) |
| `anchor` | an anchor is present (`null` = not anchored yet, status `pending`) and fits its mode |
| `merkleProof` | leaf + proof hash to the anchor's root (local) |
| `batch` | `getBatch` exists, is not voided, root and schemaVersion match |
| `onchainProof` | `registry.verifyReceipt(batchId, receipt, proof)` is true |
| `anchorTx` | the one-block `BatchAttested(batchId)` log came from `anchor.txHash`, which succeeded |
| `status` | `resolveStatus` read the finality stage |
| `spend` | every manifest spend entry that names a transaction on the receipt's chain agrees with it; skipped when none can be compared |

`spend` lists one `SpendCheck` per entry: `confirmed` (the transaction moved exactly `amount` of the asset from the agent or principal), `unattributed` (it did, but from another address: reported, not credited), `contradicted` (no such transaction, it reverted, or it moved no such amount: the receipt is invalid), `unchecked` (no `txHash`, an asset not on this chain, a fractional amount, or native ETH moved inside a contract call) or `undetermined` (RPC failure or not mined yet). `authentic` is true when every check but `spend` passed. Everything else in the manifest is the signer's word.

## Bitcoin finality

`createPopFinalityReader` implements docs/research/STATUS_RESOLUTION.md: the covering keystone
`K = ceil(B/25)*25`, a Bitcoin PoP tx whose full OP_RETURN abrev equals the canonical abrev of
`K` or a later keystone (the lowest Bitcoin height wins; later keystones anchor earlier ones),
found by polling known miner addresses and/or scanning raw Bitcoin blocks through Esplora, with
the publication block re-checked for Bitcoin reorgs below 9 confirmations. `btc-final` is 9
confirmations (`superFinal` at 11, bfgd v2). Source `"bitcoin"` is verified data. When nothing is
found, a PoP-payout liveness gate gives either `"estimate"` (expected-by times from measured
percentiles; never advances a stage) or `"unavailable"` ("no PoP activity").
`defaultFinalityReader`: mainnet polls the known miner (identities rotate) and scans up to 36
blocks; testnet only runs the liveness gate (no PoP there); other chains are `unavailable`.

Scanned block hashes are cached permanently only after a canonical-hash check at 11 or more
confirmations. A block cached while young is checked again even if a gap between reads makes
its height appear final. `waitForReceipt` applies its timeout to requests, response bodies and
polling sleeps; a supplied abort signal cancels the wait immediately.

## Tests

`npm test -w sdk` (node:test; chain tests start their own anvil and use `@hemi-receipts/e2e/lib`;
finality tests replay fixtures recorded read-only under `test/fixtures/`). `LIVE_HEMI=1` also
runs `test/live.test.ts` against the public Hemi RPCs and Esplora (read-only).
Run `npm run build -w sdk` after changing `src/`: the service and the e2e helpers import `dist/`.
