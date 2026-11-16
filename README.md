# hemi-agent-receipts

Turns an AI agent run into a signed manifest, anchors its hash on Hemi in Merkle batches, and later answers "is this receipt real, and is it Bitcoin-final?" with a proof anyone can check from a Hemi RPC alone.

- **The agent** signs an EIP-712 receipt over the manifest's hash.
- **The service** countersigns, batches receipts into a Merkle tree and anchors the root on Hemi.
- **Anyone** verifies a receipt file against the chain, with no need for the service, and sees how far it has travelled: `pending → hemi-included → hemi-confirmed → btc-published → btc-final`.

## What it is for

An AI agent that acts for someone, calls tools and spends money leaves no record that a third party can trust: logs can be edited after the fact, and the agent's operator is the one holding them. This project gives a run a receipt. When the run ends, its trace (tool calls, spend, the model used) is normalized into a manifest and signed by the agent's own key, or by the person it acted for. The signed receipt goes to a small attestation service, which gathers receipts into batches, computes a Merkle root and anchors it on Hemi in one transaction; a caller who prefers to pay its own gas can have the service countersign one receipt and send the transaction itself. The `ReceiptRegistry` contract records each batch with its root and the service's signature, and the owner key can void a bad batch, pause the contract or rotate the signer. The service charges per attestation through x402 in USDC.e, so agents pay as they go with no accounts or API keys.

The point is that the check needs nothing but a Hemi RPC and the contract address: the service does not have to be running or trusted. `receipts verify` and the SDK recompute the manifest hash, check the agent's signature, prove the receipt's leaf against the anchored root, confirm the batch is live on chain and report how settled it is, up to published to and final on Bitcoin through Hemi's proof-of-proof. Change one byte of the manifest, forge the signature or point the receipt at another batch, and verification fails with a specific reason. The [viewer](viewer/README.md) does the same check in a browser and explains the result in plain words. In practice an agent framework, or a wrapper around one, runs `receipts from-trace` and `receipts attest --wait` at the end of each run and keeps the `.receipt.json` files; a principal, auditor or counterparty runs `receipts verify` on them, or drops one into the viewer.

**Status.** Built and tested; deployed to Hemi testnet with verified source. On 2026-11-13 the registry was deployed to Hemi mainnet at [`0x95127A8aCa9B5c235C56A2dfd315a567Ef545A40`](https://explorer.hemi.xyz/address/0x95127A8aCa9B5c235C56A2dfd315a567Ef545A40), owned by the Safe `0xbe191f7072aD49c4c15434780C5cE0ED5bfB7535`, with service signer `0xcFD277613FcB5d6A7B2BFcA93d44E78a1d3c6E0c` ([DECISIONS](docs/DECISIONS.md) D-14). The mainnet smoke test ([RUNBOOK](docs/RUNBOOK.md) §7) passed the same night: three receipts paid in USDC.e, anchored in batch 1 by [`0x06396351…134b`](https://explorer.hemi.xyz/tx/0x06396351b82b2fce9f685163897b55aacbd020133e735e30f2f7a8947fda134b), and verified with the service stopped ([`demo/mainnet-smoke-20261113T022336Z`](demo/mainnet-smoke-20261113T022336Z/)). Its source is [verified on the explorer](https://explorer.hemi.xyz/address/0x95127A8aCa9B5c235C56A2dfd315a567Ef545A40?tab=contract) (exact match). The smoke-test receipts reached `btc-final` on 2026-11-14, after PoP publication paused for a day while Bitcoin fees were high (D-14).

| | Hemi testnet (`eip155:743111`) |
|------|------|
| ReceiptRegistry | [`0xef9Bb805581c0E947DEA54052Ad360485c3F73Fe`](https://testnet.explorer.hemi.xyz/address/0xef9Bb805581c0E947DEA54052Ad360485c3F73Fe), source verified |
| Owner | `0xD572EfBA712C2284D1404eE47Be1599556B321e0` |
| Service signer | `0xdd801e02554E08f00F3F833CF08C9cb9B70FeA39` |
| Relayer (pays gas, no role) | `0xACadCDeE87cDbf94d440fe10E10371F8865AC22d` |
| Live demo runs (2026-10-30 to 2026-11-05) | Each anchored receipts on testnet, reached `hemi-confirmed` and was verified with the service stopped. Batch 1, the first run: [`demo/testnet-20261030T003831Z/`](demo/testnet-20261030T003831Z/) (DECISIONS.md D-11). Batch 3, the first with all three tamper cases: [`demo/testnet-20261030T012224Z/`](demo/testnet-20261030T012224Z/), tx [`0xadc7f7ba…1550`](https://testnet.explorer.hemi.xyz/tx/0xadc7f7ba75c571e5b7afa5e1e59f39cf104b99dbe0f3008e68de859689f61550). Batch 6, the command below exactly as written, with `run.log`: [`demo/testnet-20261030T015811Z/`](demo/testnet-20261030T015811Z/), tx [`0x4b9f8a72…3e92`](https://testnet.explorer.hemi.xyz/tx/0x4b9f8a72a9aa1368e453e4015924896a1a3f0a4974a857404ef3dffa57eb3e92). Batch 19: Hemi testnet stopped mining ordinary transactions on 2026-11-04 from about 12:13 UTC, so this run timed out with its receipts pending (`run.log`). After testnet recovered on 2026-11-05, the restarted service re-signed and resent the batch, and the run's remaining steps finished from the same manifests (`resume.log`): [`demo/testnet-20261104T161720Z/`](demo/testnet-20261104T161720Z/), tx [`0xa5a78e14…f918`](https://testnet.explorer.hemi.xyz/tx/0xa5a78e1417a59be186c2f50565205cfd5f6d42b24ba9c2ed397c5ac5e27df918). Batches 20 and 21, the last batch run and the last direct run, where the caller sends its own transaction (`scripts/testnet-direct-demo.sh`): [`demo/testnet-20261105T150109Z/`](demo/testnet-20261105T150109Z/), tx [`0x227c5f05…5804`](https://testnet.explorer.hemi.xyz/tx/0x227c5f05a3ab800600f380cc9c86115cf61c76da7a0598526cfe2f7114005804), and [`demo/testnet-direct-20261105T150519Z/`](demo/testnet-direct-20261105T150519Z/), tx [`0xb04324a8…5a6e`](https://testnet.explorer.hemi.xyz/tx/0xb04324a80370afc02c15fe86f612d25e3a8315945d6a20938c65099068445a6e). Absolute paths in these logs were shortened to paths from the repository root. |

| Path | What it is |
|------|------|
| [`contracts/`](contracts/README.md) | `ReceiptRegistry.sol`: batch and direct anchoring, dual signatures, void, pause; Hardhat tests; Ignition deployment |
| [`sdk/`](sdk/README.md) | `@hemi-receipts/sdk`: manifest schema and RFC 8785 hashing, signing, Merkle proofs, `verify`, Bitcoin finality reader, RPC client with retries |
| [`cli/`](cli/README.md) | `receipts`: `from-trace`, `attest`, `status`, `fetch`, `verify` |
| [`service/`](service/README.md) | Attestation service: `POST /attest` (x402-paid), batcher, status poller, SQLite; Dockerfile |
| [`viewer/`](viewer/README.md) | Receipt viewer: one page that verifies a receipt in the browser and explains it to a non-technical reviewer |
| [`e2e/`](e2e/) | The Definition of done as one test, plus shared helpers (anvil, deployer, fault-injecting RPC proxy) |
| [`docs/SCHEMA.md`](docs/SCHEMA.md) | Every hashed, signed or anchored byte: manifest v1, receipt file, leaf, EIP-712, contract interface |
| [`docs/DECISIONS.md`](docs/DECISIONS.md) | The design decisions and every verify-first item, with commands and outputs |
| [`docs/RUNBOOK.md`](docs/RUNBOOK.md) | Accounts, deployment, incidents |
| [`docs/research/STATUS_RESOLUTION.md`](docs/research/STATUS_RESOLUTION.md) | How the Bitcoin stages are read, and why no Hemi API is used |

## Quickstart

Everything runs on your machine: a local chain (anvil, in Docker), the registry, the attestation service and the CLI. It needs no keys, no funds and no Hemi network. You need Node 22.18 or later, Docker with Compose v2, and `jq` for the tamper step.

```bash
git clone https://github.com/dimitryB/hemi-agent-receipts && cd hemi-agent-receipts
npm ci && npm run build                 # run npm from the repo root: its .npmrc points at the public registry
npm run compile -w contracts            # the local deployer reads the contract artifact
docker compose --profile local up -d --wait receipts-local
```

This starts anvil (chain 31337, on `127.0.0.1:8545`; set `LOCAL_RPC_PORT` if that port is taken), deploys the registry at `0x5FbDB2315678afecb367f032d93F642f64180aa3`, and runs the service on `http://127.0.0.1:8788` with `DEV_FREE=1`, so nothing asks for payment. The first run builds the service image. Every key involved is one of anvil's well-known dev accounts, which hold value only on a local chain. The deployer reads `contracts/artifacts` through a bind mount, so with Colima or another VM-based Docker, clone under a folder the VM shares (Colima shares your home directory by default); elsewhere the deployer reports that it cannot read the artifact.

Attest the three example manifests, then check them with the service stopped:

```bash
export RECEIPTS_SERVICE_URL=http://127.0.0.1:8788
export AGENT_PRIVATE_KEY=0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6  # anvil dev account 3, the examples' agent
node cli/dist/index.js attest examples/manifests/demo-1.json examples/manifests/demo-2.json examples/manifests/demo-3.json --wait=hemi-confirmed --out receipts/

LOCAL="--rpc http://127.0.0.1:8545 --registry 0x5FbDB2315678afecb367f032d93F642f64180aa3"
docker compose --profile local stop receipts-local       # verification needs only the chain
for f in receipts/*.receipt.json; do node cli/dist/index.js verify "$f" $LOCAL; done   # each: valid, exit 0
F=$(ls receipts/*.receipt.json | head -1)
jq '.manifest.model |= .[:-1] + "X"' "$F" > tampered.json
node cli/dist/index.js verify tampered.json $LOCAL         # one byte changed: invalid, exit 1
docker compose --profile local down
```

The three receipts share one batch and one anchoring transaction. `attest` prints `<runId> hemi-confirmed` for each and writes `receipts/<runId>.receipt.json`; `verify` prints every check. A local chain never reaches the Bitcoin stages. The same steps against Hemi testnet are [item 2](#definition-of-done-how-to-check-each-item) below, with your own keys ([Your own testnet deployment](#your-own-testnet-deployment)).

## Tests

The test suites also need Foundry (`anvil`, `cast`) and `openssl`:

```bash
npm ci
npm run build     # sdk, cli, service, viewer
npm test          # contracts, sdk, cli, service, viewer and the end-to-end Definition-of-done test
```

`npm test` takes a few minutes and needs no Hemi network: every chain test runs on a local anvil. The first contract compile downloads solc 0.8.28 once. The end-to-end test runs the real service and CLI binaries, with every chain call going through a proxy that randomly fails 20 to 30% of requests (HTTP 429/5xx, resets, stalls, JSON-RPC errors, and answers dropped after the request took effect).

## Your own testnet deployment

The scripts that deploy and run on Hemi testnet read keys from `.secrets/` (gitignored) and write the service's settings to `.env` (gitignored). Neither is in the repository: create your own keys, and keep them out of your shell history and of any commit.

```bash
mkdir -m 700 -p .secrets
for role in owner service relayer agent; do (umask 077 && cast wallet new --json > .secrets/testnet-$role.json); done
```

Fund the relayer with about 0.002 testnet ETH ([RUNBOOK §2](docs/RUNBOOK.md#2-day-one-testnet-gas) says how); the other three need none. Then:

```bash
scripts/testnet-deploy.sh --fork   # rehearsal on an anvil fork of Hemi testnet; sends nothing live
scripts/testnet-deploy.sh          # deploys your own registry, verifies its source, writes .env
scripts/testnet-demo.sh            # item 2 below: three receipts, one batch, verified with the service stopped
```

Your registry is not the SDK's known deployment, so pass `--registry <your address>` (the `REGISTRY_ADDRESS` in `.env`) to `receipts verify` and `receipts status`; the demo script does. Without any keys you can still verify this project's own testnet and mainnet receipts: [item 3](#definition-of-done-how-to-check-each-item) needs only the public RPC.

## Paid requests through x402facilitator

With `DEV_FREE` unset, the service answers `POST /attest` with an x402 402 and settles the payment through a facilitator. [x402facilitator](https://github.com/dimitryB/x402facilitator) (Apache-2.0) is a separate project. Item 7's demo runs both on local forks of Hemi; it needs no keys and no `.env` in either project, only anvil's dev accounts on the forks:

```bash
git clone https://github.com/dimitryB/x402facilitator ../x402facilitator   # or anywhere, then export X402_FACILITATOR_DIR=<path>
(cd ../x402facilitator && docker compose build)                            # its facilitator image; the first build takes a few minutes
scripts/x402-fork-demo.sh                                                  # needs Foundry, jq and npm run build here
```

The forks read state from Hemi's public RPCs, so this demo needs network access. If port 8080 is taken, set `FACILITATOR_PORT`. A real deployment runs x402facilitator with its own signer keys; its README covers that.

## Definition of done: how to check each item

1. **Contract on testnet with verified source; owner and service key are different accounts.** Open the explorer link above, or read it back:

   ```bash
   R=https://testnet.rpc.hemi.network/rpc; A=0xef9Bb805581c0E947DEA54052Ad360485c3F73Fe
   cast call $A 'owner()(address)' --rpc-url $R; cast call $A 'serviceSigner()(address)' --rpc-url $R
   curl -s https://testnet.explorer.hemi.xyz/api/v2/smart-contracts/$A | jq '{is_verified, name, compiler_version}'
   ```

   The contract itself refuses an owner equal to the service signer. The deployment record is in [DECISIONS.md D-10](docs/DECISIONS.md).

2. **`docker compose up` runs the service; three manifests give three receipt ids in one `BatchAttested` tx; `receipts status` shows at least `hemi-confirmed`.** It needs your own testnet deployment ([above](#your-own-testnet-deployment)): `.env` and `.secrets/testnet-agent.json`. Without keys, the [Quickstart](#quickstart) runs the same steps on a local chain. Then:

   ```bash
   scripts/testnet-demo.sh
   ```

   If Docker's virtual disk is full, the service refuses to start with "database or disk is full". Prefix the command with `COMPOSE_FILE=docker-compose.yml:docker-compose.host-data.yml`, which keeps the database in `./data` on the host. The committed runs used it.

   It runs `docker compose up -d receipts` with the existing image; compose builds it if it is missing. After changing service code, run `docker compose build` first or set `BUILD=1`; a rebuild needs free space on Docker's disk. The script builds three fresh manifests with `receipts from-trace`, and runs `receipts attest` on them. It fails unless all three anchors share one transaction and one batch id, and the transaction carries exactly one `BatchAttested` event for that batch with count 3. It then polls `receipts status --no-btc`, which shows the service's own poller status, until each is `hemi-confirmed` (the safe head plus 10 blocks, a few minutes), and stops the service. Finally it runs `receipts verify` on each receipt, and on tampered copies: one changed manifest byte, a forged agent signature, and, when an earlier batch exists, a proof pointed at that batch. Each tampered copy must exit 1. Everything, including the console output (`run.log`), lands in `demo/testnet-<time>/`; the committed run is linked in the table above. By hand, the core is:

   ```bash
   docker compose up -d receipts
   AGENT_PRIVATE_KEY=… node cli/dist/index.js attest m1.json m2.json m3.json --wait=hemi-included --out receipts/
   node cli/dist/index.js status <runId>
   ```

3. **`receipts verify` gives `valid: true` for a real receipt, and `valid: false` with a reason for (a) one changed manifest byte, (b) a proof against the wrong batch, (c) a forged agent signature.** Covered against the real binaries by `npm test -w e2e` (`e2e/test/dod.test.ts`). To try it on a testnet receipt from the demo run:

   ```bash
   F=demo/testnet-20261030T012224Z/receipts/0x9b198a4c3d47543388630c697611115b8773eb30d09bf4ebd22281b5b03f4191.receipt.json
   node cli/dist/index.js verify "$F"                                 # exit 0, valid
   T=$(mktemp); jq '.manifest.model |= .[:-1] + "X"' "$F" > "$T"
   node cli/dist/index.js verify "$T"                                 # one byte changed: exit 1, manifest hash mismatch
   ```

   `verify` prints every check (file, registry, chainId, manifest, agentSignature, anchor, merkleProof, batch, onchainProof, anchorTx, status) and a specific reason for each failure. `scripts/testnet-demo.sh` (item 2) runs all three tamper cases against live testnet receipts and keeps the outputs (`verify-tamper-*.txt`).

4. **Verification needs only an RPC URL and the contract address, proven by a test that kills the service first.** `e2e/test/dod.test.ts` stops the service process and checks that `/health` no longer answers before any `verify` runs. `scripts/testnet-demo.sh` does the same with `docker compose stop`, and fails unless `/health` stops answering before it verifies. The registry address comes from `--registry` or the SDK's known deployment, never from the receipt file.

5. **An identical manifest returns the original receipt without a new tx; a different manifest with a reused runId is rejected.** Covered by `npm test -w e2e`, which checks that the relayer's nonce and the registry's `batchCount` do not move, and by `service/test/attest-idempotency.test.ts`. With the CLI, an identical resubmission prints `(already submitted)`, and a reused runId exits 1 with a 409.

6. **The status poller reaches `btc-published` or `btc-final` on testnet, or DECISIONS.md records why that stage cannot be read yet.** It cannot be reached on testnet: nobody publishes Hemi testnet keystones to Bitcoin any more, and no Hemi-run finality API works. The evidence and the method are in [DECISIONS.md D-4](docs/DECISIONS.md). Testnet receipts therefore stop at `hemi-confirmed`, and their status carries `btc.source: "unavailable"` with the reason, checked live on every poll. On mainnet the same reader reads both Bitcoin stages from public data, and this read-only check shows it on real mainnet blocks:

   ```bash
   LIVE_HEMI=1 node --import tsx --test sdk/test/live.test.ts
   ```

   It shows mainnet block 5620209 as `btc-final` via keystone 5620225 in Bitcoin block 973746, block 5619605 as `btc-final` through a later keystone, and a fresh testnet block as `hemi-confirmed` with "no PoP activity". An estimate never advances a stage.

7. **`POST /attest` returns 402 with valid x402 payment requirements when `DEV_FREE` is unset, and settles against [x402facilitator](https://github.com/dimitryB/x402facilitator) when it is available.** The 402 is covered by `npm test -w e2e` and `service/test/x402.test.ts`. It answers even when the facilitator is down, because the requirements come from configuration. Settlement through x402facilitator runs entirely on local forks of Hemi; [Paid requests through x402facilitator](#paid-requests-through-x402facilitator) says how to get it:

   ```bash
   scripts/x402-fork-demo.sh
   ```

   The demo forks Hemi with the facilitator project's own script and starts its facilitator image. It then runs this service with `DEV_FREE` unset, and has the CLI pay the 402 with x402 (USDC.e through Permit2). Finally it checks that `payTo` received exactly the price and that the receipt was anchored. The result of the last run is in [DECISIONS.md D-12](docs/DECISIONS.md).

8. **SCHEMA.md and the SDK types agree, enforced by a pinned digest.** `sdk/test/schema-doc.test.ts` compares the field tables in SCHEMA.md with the SDK's field lists, and hashes the fixture in SCHEMA.md §1.4 to the pinned `manifestHash` and leaf. An independent Python canonicalization gives the same digest (DECISIONS.md D-1).

9. **DECISIONS.md records the four design decisions and every verify-first item with its command and output.** The decisions are D-1 to D-4; the verify-first table at the top links each item to its entry.

## Receipt viewer

A single page for a reviewer who is not an engineer. It shows the run (who, when, which tools, what it spent) beside a plain verdict, the finality ladder, every check in words, and the Merkle proof step by step. It verifies in the browser against Hemi directly; the receipts service is never asked whether a receipt is real.

```bash
npm run build && npm run serve -w viewer    # then open http://127.0.0.1:5180/?sample=genuine
```

The examples are real testnet receipts, a genuine one and its tampered copies. Details are in [viewer/README.md](viewer/README.md) and [DECISIONS.md D-13](docs/DECISIONS.md).

## How it works

```
agent ──signs Receipt──▶ receipts attest ──POST /attest──▶ service ──attestBatch(root)──▶ ReceiptRegistry on Hemi
                                                              │                                │
receipt file ◀── GET /receipts/:runId ◀── proof, status ◀─────┘                                │
     │                                                                                         │
     └──────────── receipts verify (RPC + registry address only) ◀─────────────────────────────┘
```

- **Manifest.** Off-chain JSON, RFC 8785-canonicalized, keccak256-hashed. Only the hash, run id, agent, principal and schema version go on chain ([SCHEMA.md](docs/SCHEMA.md) §1).
- **Batches.** 64 receipts or 60 seconds, whichever comes first. Sorted-pair Merkle tree, `leaf = keccak256(abi.encode(runId, manifestHash, agent, principal))`. A direct path (`POST /attest/direct`) returns signed calldata for callers who want their own transaction (D-2).
- **Signatures.** The agent or its principal signs the receipt; the service countersigns a domain-separated envelope with a deadline (D-3).
- **Status.** `hemi-confirmed` means at or below Hemi's safe head, at least 10 blocks deep and still canonical. The Bitcoin stages come from finding the PoP transaction that carries the covering keystone on Bitcoin (D-4).
- **Flaky RPCs.** Every chain call retries with backoff and is paced under the public RPC's ~300 requests a minute. The batcher is crash-safe: it stores the signed transaction before broadcasting, and a root can be anchored only once (service README).
- **Payments.** x402 `exact` in USDC.e: Permit2 on testnet, EIP-3009 on mainnet. Validation and replay checks run before the paywall, so nobody pays for a rejected request or a resubmission (D-7, D-12, service README).

## Known limits

- **Mainnet** has the registry (D-14) and has served the three paid receipts of the smoke test. Its USDC.e address rests on Hemi's token list, on-chain reads and the explorer's own record (DECISIONS.md D-7, Q-1). Look-alike tokens share the USDC.e and hemiBTC symbols on mainnet; the code names tokens only by address.
- **Bitcoin stages on testnet** cannot be reached until Hemi runs PoP on testnet again (D-4).
- **Bitcoin data on mainnet** comes from public Esplora APIs, which are trusted for it; hVM's `0x43` precompile gives a cross-check. PoP miner addresses rotate; the reader also scans Bitcoin blocks to find new ones. Anyone can add transactions to a miner's address history, so a full page of forged low keystones can end the address search early. That only understates finality, and block scanning finds the publication where it is on; the viewer has it off by default.
- **A settlement whose outcome is unknown** is held for 30 minutes (D-12), and then the payment's nonce on chain decides. This covers a lost answer, a kill mid-settlement and a named transaction that never appears. If the nonce is used, the payment landed: the receipt is accepted and nobody is charged again. If it is unused and the authorization has expired, the payment can never land, so a retry may pay. If the read fails, or the authorization is still inside its deadline, the hold stays, so a long RPC outage holds the receipt that long. Only a retry asks the chain about a lost answer or a kill, so a buyer who paid and never comes back gets no receipt.
- **A held payment the logs cannot decide stays held.** When a payment's outcome is unknown and its hold runs out, a used nonce counts as paid only with a `Transfer` to `PAY_TO` in the transaction that carries that nonce, and the buyer's own cancel releases the receipt so a retry pays (D-12). If the RPC returns neither, the receipt stays held and the log names the payer and nonce; the next read decides.
- **Batch path trust.** On the batch path the contract sees only a root, so the service is trusted not to anchor receipts it should not. Every agent signature is still checked by `verify`, and a bad batch can be voided by the owner.
- **The service listens on 127.0.0.1 only** in `docker-compose.yml`. With `DEV_FREE=1` (as `scripts/testnet-deploy.sh` writes it), anyone who can reach the port could anchor on the relayer's gas. Expose it only behind a proxy, and with payments on.
- **Hardhat's Blockscout verifier** gets HTTP 403 from the testnet explorer; `scripts/testnet-deploy.sh` verifies through Blockscout's v2 API instead (D-10).
- **`npm audit --omit=dev` reports `zod@3`** (GHSA-mrhx-c7xc-m3w5, fixed in zod 4.6.6). That copy is Hardhat's, a dev dependency of `contracts` hoisted to the root; it counts as production only because `abitype` (under `viem`) lists zod as an optional peer whose range it happens to satisfy. Nothing installs zod for `abitype`, `viem` never imports `abitype/zod`, and a module-load trace of the CLI and the service shows only `@x402`'s own nested zod 4.6.7 loading. An override cannot move it: every Hardhat 3 package requires `zod ^3` (still so in Hardhat 3.22.0, checked 2026-11-15), the advisory has no fixed 3.x release, and forcing zod 4 breaks Hardhat's config errors (it reads `ZodError.errors`, which zod 4 removed). It goes away when Hardhat moves to zod 4.

## Security

Report vulnerabilities privately, as described in [SECURITY.md](SECURITY.md). The contracts have had an internal review ([docs/SECURITY-AUDIT.md](docs/SECURITY-AUDIT.md)), not an independent audit.

## License

[MIT](LICENSE).
