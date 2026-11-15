# hemi-agent-receipts service

Turns an AI agent run into an anchored receipt. A client posts a manifest (or just its five
receipt fields) with the agent's EIP-712 signature. The service batches receipts into Merkle
trees and anchors each root on Hemi with `attestBatch`. It then reports how far each receipt
has travelled toward Bitcoin finality. Byte-level formats are in [`docs/SCHEMA.md`](../docs/SCHEMA.md).

```
client ──POST /attest──▶ validate ─▶ idempotency ─▶ x402 paywall ─▶ unpaid ─settle─▶ queued
                                                                                     │
         GET /receipts/:runId ◀── status poller ◀── mined ◀── sent ◀── signed ◀── batcher
```

## Run it

```bash
npm ci                                   # from the repo root (root .npmrc → public registry)
npm run build -w sdk && npm run build -w service
cp .env.example .env                     # fill REGISTRY_ADDRESS, SERVICE_PRIVATE_KEY, PAY_TO …
node --env-file=.env service/dist/index.js
```

Docker (build context is the repo root):

```bash
docker compose build
docker compose up -d receipts            # reads .env; DB on the receipts-data volume; :8787
docker compose --profile local up receipts-local   # offline demo, see below
```

The `local` profile runs anvil (`ghcr.io/foundry-rs/foundry:v1.3.5`) and a one-shot deployer
(`service/dist/tools/deploy-local.js`, which refuses any chain but 31337). It also runs the
service on `:8788` with `DEV_FREE=1`, anvil's public dev keys and a throwaway database. It
needs the contract artifact, so run `npm run compile -w contracts` once first. Stop it with
`docker compose --profile local down`.

The container runs as `node` (uid 1000). Its healthcheck is `GET /health`. Compose restarts it
`on-failure:5`, so a refused configuration gives up after five tries instead of looping.

## HTTP API

The read-only routes (`GET /receipts/:runId`, `GET /batches/:id`, `GET /health`) send `Access-Control-Allow-Origin: *`, so the receipt viewer (`viewer/`) can load receipts from another origin. The paid POST routes send no CORS headers.

Every error is JSON: `{ "error": "<code>", "message": "…", …details }`.

### `POST /attest`: anchor in the next batch

```bash
curl -s localhost:8787/attest -H 'content-type: application/json' -d '{
  "manifest": { "receiptVersion": 1, "runId": "0x…", "agent": "0x…", "principal": "0x…", … },
  "agentSignature": "0x…",
  "store": false
}'
# or, keeping the manifest private, only the five on-chain fields:
curl -s localhost:8787/attest -H 'content-type: application/json' -d '{
  "receipt": { "runId": "0x…", "manifestHash": "0x…", "agent": "0x…", "principal": "0x…", "schemaVersion": 1 },
  "agentSignature": "0x…"
}'
```

- `manifest` is normalized (EIP-55 and upper-case hex accepted) and validated with the SDK. If
  `receipt` is sent too, the two must agree (`400 manifest_receipt_mismatch`). `store: true`
  keeps the canonical manifest (at most `STORE_MANIFESTS_MAX_BYTES`) and returns it in the
  receipt file.
- `agentSignature` must be the EIP-712 `Receipt` signature for this registry's domain, by the
  agent or the principal, and one the registry would accept. An account without code is
  checked with ECDSA, as OpenZeppelin does: 65 bytes, `v ∈ {27,28}`, low `s`. An account that
  has code (a contract wallet, or an EIP-7702-delegated EOA) is checked only through EIP-1271
  `isValidSignature` over the RPC, as the contract does. Whether an account has code is cached
  for ten minutes; the lookups and the EIP-1271 calls share one rate limit
  (`503 signature_check_busy`). An ECDSA match whose account cannot be looked up right now is
  accepted, as before the code check existed.
- Validation and the idempotency lookup run **before** the paywall, so nobody pays for a
  rejected request or a replay:

| Case | Answer |
|------|------|
| new receipt | `202 { runId, status: "pending", receiptUrl, leaf }` (after payment unless `DEV_FREE=1`) |
| same `runId`, same leaf (same manifest hash, agent, principal) | `200` with the stored receipt file; no tx, no payment |
| same `runId`, different leaf, already accepted | `409 run_id_conflict` |
| same `runId` while another request's payment for it is settling | `409 payment_pending` for the same leaf, `409 run_id_conflict` for another (`Retry-After: 30`) |
| same `runId`, different leaf, nobody paid (the earlier payment was refused) | treated as a new receipt: the run id was never taken |
| invalid body or manifest, bad signature | `400 invalid_request` / `invalid_json` / `invalid_manifest` / `invalid_receipt` / `invalid_agent_signature` |
| no payment | `402` with the `PAYMENT-REQUIRED` header (x402 v2) |
| an earlier payment is `settlement_pending` or its outcome is unknown | `409 payment_pending` (`Retry-After: 60`) while the hold lasts. After it the payment's nonce on chain decides: used, `200` with no charge; unused and expired, paid as new; otherwise still `409` |
| registry paused / schema version disabled | `503 registry_paused` / `400 schema_version_disabled` |
| body over 1.2 MB | `413 payload_too_large` |

### `POST /attest/direct`: sign for the caller's own transaction

Same body and the same checks; priced at `PRICE_DIRECT`. The answer is everything needed to
send `attest(...)` yourself:

```json
{ "receipt": {…}, "agentSignature": "0x…", "deadline": 1793318629, "serviceSignature": "0x…",
  "registry": "0x…", "chainId": 743111, "to": "0x…", "data": "0x…", "receiptUrl": "…" }
```

```bash
cast send "$(jq -r .to r.json)" "$(jq -r .data r.json)" --rpc-url … --private-key …
```

A new submission is answered `202`. The signature is valid for `SIGNATURE_TTL_SECONDS` (30 min).
An identical request returns the same answer (`200`, plus `status`) for free, re-signed if it
is about to expire. The SDK's `submitDirect` returns it as `result.direct`; the CLI's `--direct`
writes it to `<runId>.attest.json`. The poller detects the transaction
with `batchIdOfRun(runId)`, reads `getBatch` for the block, then runs a one-block `eth_getLogs`
for the tx hash, and fills the anchor: `mode: "direct"`, `proof: []`. A receipt can be
anchored on one path only (`409 run_id_conflict` on the other).

### `GET /receipts/:runId`

The receipt file of SCHEMA.md §2 plus `status` (the SDK's `StatusInfo`). `anchor` is `null`
until mined, and `manifest` is present only if stored. `404` for unknown or unpaid run ids.

```bash
curl -s localhost:8787/receipts/0x… | jq '{stage: .status.stage, anchor}'
```

### `GET /batches/:id`

`:id` is the service's **local** batch id. The on-chain id is `batchId`. The response has
`root`, `count`, `state`, `stage`, `status`, `txHash`, `blockNumber`, `runIds` and `lastError`.

### `GET /health`

```json
{ "ok": true, "chainId": 743111, "registry": "0x…", "serviceSigner": "0x…", "relayer": "0x…",
  "devFree": false, "pending": 3, "queue": { "queued": 2, "batched": 1, "directAwaitingTx": 0, "anchored": 120 },
  "lastBatch": { "id": 41, "batchId": 57, "txHash": "0x…", "stage": "hemi-confirmed", … },
  "rpc": { "ok": true, "latestBlock": 7100812 }, "finality": "sdk defaultFinalityReader",
  "batcher": { "lastError": null }, "poller": { "lastError": null } }
```

The status is HTTP 200 whenever the database answers, so an RPC outage does not get the
container restarted. `ok` is false while the RPC is unreachable.

## Configuration

All variables are read once at startup. Every problem is reported at once, and secrets are
never echoed. [`.env.example`](../.env.example) documents each one.

| Variable | Default | |
|------|------|------|
| `CHAIN_ID` | `743111` | The RPC's chain id must match, or startup is refused. |
| `HEMI_RPC_URLS` | SDK's RPCs for the chain | Comma list, tried in order. |
| `REGISTRY_ADDRESS` | required | Its `serviceSigner()` must be `SERVICE_PRIVATE_KEY`'s address, or startup is refused (both addresses are named). |
| `REGISTRY_DEPLOY_BLOCK` | `0` | |
| `SERVICE_PRIVATE_KEY` | required, **secret** | Signs BatchAttestation and ServiceAttestation. |
| `RELAYER_PRIVATE_KEY` | `SERVICE_PRIVATE_KEY`, **secret** | Pays gas. Dedicate it: the batcher owns its nonces. |
| `DB_PATH` | `./data/receipts.sqlite` | Bound to one chain + registry on first start. |
| `PORT` / `HOST` / `PUBLIC_BASE_URL` | `8787` / `0.0.0.0` / from `Host` | |
| `BATCH_MAX_SIZE` | `64` | 1 to 65,536. |
| `BATCH_MAX_WAIT_SECONDS` | `60` | |
| `HEMI_CONFIRMATIONS` | `10` | |
| `POLL_INTERVAL_SECONDS` | `15` | Also `POLL_MAX_INTERVAL_SECONDS` (600) and `POLL_MAX_BATCHES_PER_TICK` (20). |
| `SIGNATURE_TTL_SECONDS` | `1800` | The registry allows at most 3600. |
| `STUCK_TX_SECONDS` | `180` | |
| `DEV_FREE` | `0` | `1` = no payment. |
| `FACILITATOR_URL` | `http://localhost:8080` | |
| `PAY_TO` | required unless `DEV_FREE=1` | |
| `PRICE_BATCH` / `PRICE_DIRECT` | `1000` / `10000` | USDC.e base units ($0.001 / $0.01). |
| `PAYMENT_ASSET*` | USDC.e for 743111 / 43111 | Only for another asset or chain. |
| `STORE_MANIFESTS_MAX_BYTES` | `1048576` | `0` disables storage. |
| `FINALITY` | `on` | `off` = Bitcoin stages not read. |
| `BTC_ESPLORA_URLS`, `POP_MINER_BTC_ADDRESSES`, `BTC_SCAN_MAX_BLOCKS` | SDK defaults | Overrides for `defaultFinalityReader`. |
| `RPC_REQUESTS_PER_SECOND` / `RPC_BURST` / `RPC_TIMEOUT_MS` / `RPC_RETRY_COUNT` / `RPC_RETRY_DELAY_MS` | `4` / `8` / `15000` / `6` / `250` | SDK client: fallback, backoff retries, token bucket. |
| `LOG_LEVEL` | `info` | |

## Batcher

A batch closes when `BATCH_MAX_SIZE` receipts are queued, or when the oldest has waited
`BATCH_MAX_WAIT_SECONDS`, whichever comes first. A batch holds one schema version and has at
most one transaction in flight at a time.

```
queued receipts ──close──▶ signed ──persist raw tx + hash──▶ sent ──receipt──▶ mined
                             ▲                                 │
                             └── reverted (fresh nonce) ───────┤
                             └── deadline passed / stuck (same nonce, fees +12.5 %)
```

Crash safety rests on four rules: state is persisted before every side effect, the root is
fixed once a batch closes, every transaction hash is known before broadcast, and the
registry anchors a root only once.

1. **Close:** one transaction assigns the receipts, stores every Merkle proof (SDK
   `buildMerkleTree`), the root, and the service's BatchAttestation signature (deadline 30 min
   ahead).
2. **Send:** the batcher first asks `batchIdOfRoot(root)`. A non-zero answer means already
   anchored, so it adopts that anchor: `getBatch`, a one-block `getLogs`, done. Next it
   simulates `attestBatch` with `estimateContractGas`. A `RootAlreadyAttested` revert is
   treated as success; `ExpiredSignature`/`DeadlineTooDistant` triggers a re-sign. Then it signs
   an EIP-1559 tx from the relayer with priority fee
   `max(eth_maxPriorityFeePerGas, 1,000,000 wei)` (Hemi testnet never mines less; x402facilitator
   D-018) and max fee `2 × base + priority`. The raw tx and `keccak256(raw)` are **stored
   before** `eth_sendRawTransaction`.
3. **Follow up:** look up every hash this batch ever signed. A successful receipt has its
   `BatchAttested` event parsed for the on-chain batch id. A reverted one means the root is
   checked again, otherwise the batch is re-sent with a fresh nonce. With no receipt, the
   same raw bytes are re-broadcast; "already known" and "nonce too low" are expected answers.
   This resolves a lost answer ("was my tx sent?") and a crash between signing and mining
   without re-signing.
4. **Deadline passed unmined:** the batcher re-signs the **same root** with a new deadline
   and replaces the tx with the same nonce. Root uniqueness makes double anchoring impossible.
5. **Stuck** (pending longer than `STUCK_TX_SECONDS` while blocks keep coming): it replaces
   the tx with the same nonce and fees raised by at least 12.5 %. Replacements are capped at
   10× the current fee suggestion, so a stalled chain is waited out, not outbid without bound.

Every chain call goes through the SDK client (fallback, retries, 4 req/s token bucket). A
failing step backs off exponentially, up to 60 s, and is recorded in `batches.last_error`.

## Status poller

Each tick makes one `eth_blockNumber` call and, on Hemi networks, one `safe` head read, shared
by every batch. Then, for each due batch (at most `POLL_MAX_BATCHES_PER_TICK`), it calls the
SDK `resolveStatus` (passing `latestBlock`, `safeBlock` and the stored `anchorBlockHash`) and
`getBatch` (the void check). RPC use grows with batches, not receipts. Young batches are
checked every `POLL_INTERVAL_SECONDS`. Confirmed ones are checked at `age / 10`, between that
and `POLL_MAX_INTERVAL_SECONDS`. `btc-final` and `voided` batches are no longer checked.
Errors back off exponentially, up to 5 min.

- `pending → hemi-included → hemi-confirmed → btc-published → btc-final`. Hemi progress is
  retained through lagging RPC reads. If the anchoring block is reorged out, `resolveStatus` answers
  `pending`. The batch then goes back to the batcher (`sent`, which looks its hashes up again)
  and its receipts go back to `pending`. A direct receipt goes back to detection.
- A provisional `btc-published` status returns to `hemi-confirmed` when the Bitcoin reader no
  longer confirms its publication, including after a Bitcoin reorg or an unavailable read.
  The response replaces the old Bitcoin evidence with the current result. The Hemi anchor stays
  intact, and later polls can advance the receipt again.
- `voided` (`getBatch(id).voided`) is terminal.
- Bitcoin stages come from the SDK's `defaultFinalityReader(CHAIN_ID, { esploraUrls,
  minerAddresses, scanMaxBlocks })` (`FINALITY=off` disables it). The reader is consulted at
  most once per batch per poll, and only for batches already `hemi-confirmed` or
  `btc-published`.
- If a safe-head read fails on a Hemi network, the tick fails, so nothing is promoted on
  partial data. After five failing ticks in a row, the confirmation count alone applies.

## x402

The wiring follows the seller in [x402facilitator](https://github.com/dimitryB/x402facilitator) (`seller/server.ts`): `@x402/express`,
`x402ResourceServer`, `HTTPFacilitatorClient` and `ExactEvmScheme`. The price is an explicit
`AssetAmount` on `eip155:<CHAIN_ID>`: USDC.e with `assetTransferMethod: "permit2"` on testnet,
and `eip3009` with EIP-712 name `Bridged USDC (Stargate)`, version `2`, on mainnet.

**Ordering, read from `@x402/express` 2.29.0:** for the exact scheme's default `authorization`
flow, the middleware does the following:

1. verifies the payment with the facilitator;
2. runs the route handler with the response buffered;
3. settles;
4. only then releases the response.

If settlement fails, the buffered body is discarded and the client gets a 402. If the handler
answers ≥ 400 or throws, the payment is never settled. **The handler therefore runs before
the money moves.**

Consequences in this service:

- The handler stores the receipt as `unpaid`, which is never batched and never returned by
  `GET /receipts`. The `onAfterSettle` hook promotes it to `queued` once the facilitator
  reports success, before the 202 reaches the client. The hook finds the receipt through
  response headers the handler sets (`x-receipt-run-id`, `x-receipt-leaf`).
- A failed settle leaves the receipt `unpaid`: nothing is anchored for free. A retry with a
  valid payment re-runs the handler on the same row, and its own settlement promotes it.
- On the direct path the service signature sits in the buffered body. It is released only
  after settlement.
- A request that races an identical, already-paid one gets `409 already_submitted`, so its
  payment is not settled.
- A request that stores an `unpaid` row holds a **settlement lease** on it
  (`settle_lease_until`, 30 min, ended by the settle hooks) while its payment settles. A second
  request for the same receipt during the lease gets `409 payment_pending` with `Retry-After`,
  from the precheck or, when both passed the precheck before either stored anything, from the
  handler's refused rewrite. Without the lease two overlapping requests both reached the handler,
  both answered 202 and both settled.
- Settling starts by recording the payment on the row (`payment_json` status `settling`: payer,
  nonce, deadline, asset, amount, the chain's head as `settleBlock` and the time), so a kill from
  then on leaves what the chain needs to be asked. The head is read with a 2 s limit; without it
  the payment still settles, and a later search starts from the time instead.
  If that write fails the settlement is refused (`payment_not_recorded`, a 402): nothing has moved.
- A failure that names a transaction, such as a `settlement_pending` answer (broadcast, not yet
  mined), is recorded with its tx hash, whatever the reason given.
  Retries get `409 payment_pending` instead of a second charge. The poller checks that tx: if
  it mined and moved exactly the price to `PAY_TO` in the payment asset, the receipt is
  accepted late; if it reverted it is released at once; if it never appears, the payment's nonce
  decides once the 30 min are over.
- A settlement whose outcome is **unknown** (a timeout, a dropped connection, an HTTP error
  without a verdict, `unexpected_*` or `invalid_transaction_state`, all with no tx hash) may have
  moved the money. It is recorded as `settlement_unknown`, logged as an error with the payer,
  nonce and amount, and held for 30 min the same way.
- **When a hold runs out, the chain decides**, before anyone can pay again (DECISIONS.md D-12).
  The next request reads the nonce of a `settlement_unknown`, and the poller that of a named
  transaction it gives up on. EIP-3009 reads `authorizationState(from, nonce)` on the token;
  Permit2 reads bit `nonce & 0xff` of `nonceBitmap(from, nonce >> 8)`.
  - Used. A used nonce does not show that money moved, because a buyer can spend its own nonce
    with a cancel, so the logs decide, from `settleBlock` (less 100) to the authorization's
    deadline (plus 100), in 5,000-block pieces:
    - The buyer's cancel (`AuthorizationCanceled(from, nonce)` on the token,
      `UnorderedNonceInvalidation(from, word, mask)` with this nonce's bit on Permit2): nothing
      was paid. The row becomes `settlement_abandoned` with `cancelTx`, and a retry pays. A
      cancel decides even next to a transfer, since Permit2 lets a paid nonce be cancelled
      afterwards.
    - A `Transfer(from, PAY_TO, ≥ amount)` on the asset in a transaction whose input carries the
      nonce: the payment landed. The row is recorded as settled with `via: "transfer"` and
      `transferTx`, and queued, and the retry gets the free replay. A transfer to `PAY_TO` that
      carries another nonce is a payment for something else, and does not count.
    - Neither: the hold stays, and the log says `neither a transfer to PAY_TO carrying it nor a
      cancel was found` with the payer, nonce and block range. So does a range over 50,000
      blocks.
  - Unused, with the authorization expired: it can never land. The row becomes
    `settlement_abandoned`, and a retry pays.
  - Unused, still inside its deadline: it can land after the read, so the hold stays. The SDK's
    buyers sign 5 minutes, so only a longer deadline gets here.
  - The read failed: the hold stays, retries get `409 payment_pending`, and the log says
    `could not read a held payment's nonce`.

  A row with no authorization on record is from before settling wrote one. It has no nonce to
  read, so it is released as before, with an error in the log.
- **Stopping.** SIGTERM or SIGINT stops taking connections at once and waits up to 185 s for
  every paid request already received, from verify through its settlement, even if its buyer
  has hung up. A paid request that arrives after the stop began, on a connection kept alive,
  gets `503 service_stopping` before verify, so nothing of it is settled. Further signals
  join the same stop; only SIGKILL cuts it short. A signal during startup exits at once,
  as nothing has been served. `stop_grace_period` in `docker-compose.yml` is 190 s, and
  `init: true` puts a small init in front of node so signals arrive during startup too. After
  a kill the next start records every row with a lease and no outcome as
  `settlement_unknown`, keeping the payer and nonce it has, and logs its run id.
- While a hold lasts it replaces the lease, so a request that passed the precheck before the
  hold began is refused by the handler and its payment is not settled.
- **Price discovery never depends on the facilitator.** A request without a payment header
  always gets the normal 402, built from configuration: network, asset, amount, `payTo`,
  `exact`, and `extra.assetTransferMethod` plus the EIP-712 name and version for EIP-3009.
  When the facilitator's `/supported` cannot be reached, the resource server is given the one
  kind this service sells (`{ x402Version: 2, scheme: "exact", network }`) by
  `FallbackFacilitatorClient`, and the real `/supported` keeps being probed in the background
  (5 s, doubling to 60 s). For `ExactEvmScheme` this is lossless: the requirements do not
  depend on the facilitator's answer. A test checks that both 402s carry identical requirements.
- **Only a request that carries a payment needs the facilitator.** While it is unreachable
  (no successful call in the last 30 s and a 5 s probe fails), or if it does not list
  `exact` on this network, such a request gets `503 payment_unavailable` with
  `Retry-After: 30`. That happens before verify, so nothing is stored and the buyer's
  authorization is not spent. verify and settle always go to the real facilitator.
- Facilitator initialization is the service's own (`syncFacilitatorOnStart=false`), because
  the SDK's background init would `process.exit(1)` on a capability error. Only a route
  misconfiguration makes paid routes answer 503 outright.

## Database

The service uses a D1-shaped adapter: `prepare(sql).bind(...).run() / first() / all()`,
`batch([...])` (atomic), and `exec`. It runs on `node:sqlite` (WAL, `synchronous=FULL`), so a
Cloudflare D1 binding can replace it (`startService(config, { db })`).

Migrations live in [`migrations/`](migrations/). They use only SQL that D1 accepts (no
PRAGMAs) and are recorded in `d1_migrations`, the table wrangler uses. On first start the
database is bound to `CHAIN_ID` and `REGISTRY_ADDRESS`; a later start against another chain or
registry is refused.

## Tests

```bash
npm test -w service             # anvil-backed; each file starts its own anvil
TEST_LOG_LEVEL=info npm test -w service
```

| File | Covers |
|------|------|
| `attest-idempotency` | 202 → identical 200 with no second tx; 409 conflict; 400 manifest/signature/mismatch; store; size limits |
| `batching` | 3 receipts → one `BatchAttested` tx; proofs pass `verifyReceipt`; `hemi-included` → `hemi-confirmed`; early close at `BATCH_MAX_SIZE` |
| `flaky-rpc` | `startFlakyRpc` at 30 % failures with `drop-response`; every broadcast answer lost; no double anchoring, no stuck nonce |
| `crash-restart` | a child process SIGKILLed after persist/before broadcast and after broadcast/before mined; restart completes once |
| `replacement` | deadline passed unmined (same root, same nonce); mined-after-deadline revert (fresh nonce); stuck tx outbid |
| `reorg` | a reorged-out anchor goes back to the batcher and lands once; detection through `resolveStatus(anchorBlockHash)` |
| `finality` | Bitcoin reads only for confirmed batches; `btc-published` → `btc-final`; no reads after final |
| `direct` | calldata sent by a test wallet is detected and anchored |
| `x402` | 402 decodes with `@x402/core`; fake facilitator: paid → queued; failed settle → nothing queued, retry works; `settlement_pending`; a lost, 502 or uncertain settle answer holds the receipt; when a hold runs out the chain decides, for Permit2 and EIP-3009, on the request path and in the poller (a transfer carrying the nonce, the buyer's cancel, a used nonce with neither in the logs, a transfer for another nonce, a Permit2 cancel of the other bits in its word, a row without a recorded head, unused, still spendable, read failed); a SIGKILL mid-settlement leaves the nonce on disk; a payment that cannot be recorded is not settled; a hold stops a request already past the precheck; direct signature only after settle; two overlapping paid requests settle once (the second gets `payment_pending`, another manifest `run_id_conflict`); a refused submission is replaced at once by a corrected manifest, which drops the old one; facilitator down → the same 402, a paid request 503, recovery when it returns; across a stop: a settling request finishes, one still verifying whose buyer hangs up is waited for, a paid request after the stop began gets 503 unverified, and the real entry point keeps draining through further signals and exits at once when signalled during a stalled startup |
| `startup` | serviceSigner, chain id, registry code, DB binding, config errors, exit code |
| `db` | D1-compatible migrations, atomic `batch`, D1 semantics |
| `x402-live` | skipped unless `X402_IT_FACILITATOR_URL`, `X402_IT_BUYER_PRIVATE_KEY` and `X402_IT_RPC_URL` are set |

## Limits and open items

- **Charged but not served:** a crash between the facilitator's settle success and the
  `unpaid → queued` write leaves a paid receipt unpaid. The write is a single local SQLite
  UPDATE, done before the response, and the success is logged only after it. So after such a
  crash this service knows the payer and nonce but not the outcome: the next start holds the
  row as `settlement_unknown`. A retry after the hold finds the nonce used and gets the
  receipt. A buyer who never retries gets none: the poller only decides named transactions.
  The facilitator's own log and the chain show the transfer.
- **A hold that the logs cannot decide stays.** A used nonce with neither a cancel nor a
  transfer carrying it in the logs keeps its receipt held, and every retry reads again. The RPC
  missing logs is the expected cause, and the next read decides. A facilitator that moved the
  money in a transaction without the nonce in its input would never be decided; the facilitator
  this service is built for calls the token's `transferWithAuthorization` or the x402 Permit2
  proxy's `settle`, both with the nonce in the call (DECISIONS.md D-12, RUNBOOK §6).
- A receipt anchored and later voided is reported `voided` only if the void happens before
  the batch reaches `btc-final`; final batches are not re-checked.
- Whether an account has code is cached for ten minutes, and an ECDSA match is accepted without
  the lookup while the signature-check rate limit is spent or the RPC does not answer. In those
  windows an EIP-7702-delegated agent's own signature can pass here and fail on chain, on the
  direct path only.
- `POST` routes are not rate limited beyond the signature-check limiter (code lookups and EIP-1271 calls). Put the service behind a
  proxy that limits per client.
