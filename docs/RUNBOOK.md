# Runbook

How to deploy ReceiptRegistry and run the attestation service on Hemi, and what to do when something goes wrong. The owner key is kept apart from the service key, the deployer key lives in an encrypted keystore, and every privileged value is read back from the explorer before go-live.

**Nothing goes to mainnet without an explicit go from the registry owner.** Testnet is unrestricted.

## 1. Accounts

Use separate accounts. The contract itself refuses an owner equal to the service signer.

| Account | Holds ETH | Lives in | Authority |
|------|------|------|------|
| Owner | only for admin calls | hardware wallet or multisig on mainnet; `.secrets/` on testnet | pause and unpause, void a batch, rotate the service signer, enable schema versions, transfer ownership (two-step) |
| Service signer | no | the service's secret store (`SERVICE_PRIVATE_KEY`) | countersigns batches and direct attestations |
| Relayer | yes, a small balance | the service's secret store (`RELAYER_PRIVATE_KEY`) | none: it only pays gas for `attestBatch` |
| Deployer | one deployment's gas | Hardhat's encrypted keystore | none after deployment: the owner and signer are constructor arguments |

A compromised service key can anchor false batches, but it cannot void, pause or administer anything. The owner voids what it signed and rotates it out (§6). A compromised relayer can only waste its own ETH.

The service signer must be a plain EOA. The registry checks its signature with ECDSA only, so a contract account, or an EIP-7702-delegated EOA, rotated in with `setServiceSigner` could never authorize an anchor until it is rotated out again. The owner is the one key whose compromise cannot be rotated away from: its voids are permanent, so on mainnet it must be a multisig or hardware wallet, never a plain hot key.

Never paste a private key into a terminal command, an issue, a chat or a log. On mainnet, record only public addresses in the release notes.

## 2. Day one: testnet gas

Testnet gas is not always easy to obtain, so check that on day one. As of 2026-10-29 it is obtainable (docs/DECISIONS.md D-9):

1. Get Sepolia ETH from any Sepolia faucet.
2. Tunnel it to Hemi testnet in the Hemi portal: https://app.hemi.xyz/en/tunnel/?networkType=testnet
3. Send about 0.002 testnet ETH to the relayer. The same account deploys.

If testnet gas cannot be had, do not block. Rehearse on a fork (`scripts/testnet-deploy.sh --fork`) and propose a minimally funded mainnet smoke test for the owner to approve.

## 3. Prepare and test

```bash
npm ci
npm test            # contracts, SDK, CLI, service and end-to-end suites
```

Do not deploy from a dirty or unreviewed commit.

## 4. Deploy to testnet

```bash
scripts/testnet-deploy.sh --fork   # rehearsal against an anvil fork of Hemi testnet; sends nothing live
scripts/testnet-deploy.sh          # live: deploys, verifies the source on Blockscout, reads every value back
```

The script reads the owner, service and relayer keys from `.secrets/testnet-{owner,service,relayer}.json` (`cast wallet new --json`); the README's [Your own testnet deployment](../README.md#your-own-testnet-deployment) shows how to create them. This project's own testnet accounts are listed in D-9. It writes `contracts/ignition/parameters/hemi-testnet.json`, checks it with `contracts/scripts/check-deploy-params.mjs`, deploys with Hardhat Ignition, submits the source to Blockscout's v2 verification API (Hardhat's own `--verify` gets HTTP 403 from this explorer; DECISIONS.md D-10), reads back `owner`, `serviceSigner`, `schemaVersionEnabled(1)` and `paused`, and checks `is_verified` on `testnet.explorer.hemi.xyz`. Finally it writes the service's `.env`.

If source verification fails but the deployment succeeded, do not deploy again. Verify by hand in the explorer's UI with Solidity 0.8.28, optimizer on with 200 runs, EVM `paris`, and the two constructor arguments.

## 5. Deploy to mainnet (only after an explicit go)

1. Create the owner on a hardware wallet or multisig, and the service and relayer keys in the service's secret store. Fund the deployer and the relayer with small balances.
2. Store the deployer key in Hardhat's encrypted keystore, entering values only at its hidden prompts:

   ```bash
   cd contracts
   npx hardhat keystore set HEMI_RPC_URL                 # https://rpc.hemi.network/rpc
   npx hardhat keystore set HEMI_DEPLOYER_PRIVATE_KEY
   ```

3. Copy `contracts/ignition/parameters/hemi-mainnet.example.json` to `hemi-mainnet.json` (gitignored) and fill in the owner and service signer.
4. Deploy. The parameter check refuses placeholders, an owner equal to the signer, and any mainnet file unless `CONFIRM_MAINNET_DEPLOY=yes` is set:

   ```bash
   CONFIRM_MAINNET_DEPLOY=yes npm run deploy:hemi -w contracts
   ```

5. Open the contract on https://explorer.hemi.xyz and confirm that the source is verified. If `--verify` failed (it got HTTP 403 on testnet), submit the source with the same Blockscout v2 call `scripts/testnet-deploy.sh` makes, pointed at `https://explorer.hemi.xyz`. Read back `owner`, `serviceSigner`, `schemaVersionEnabled(1)` (true), `paused` (false), `MAX_DEADLINE_WINDOW` (3600) and `MAX_BATCH_COUNT` (65536). Some networks cannot reach that explorer (DECISIONS.md, the note at the top), so do this from another network.
   Then read the two accounts' code back from the RPC, and stop if either is wrong:

   ```bash
   cast code <owner> --rpc-url https://rpc.hemi.network/rpc           # must NOT be 0x: a multisig has code, a plain key has none
   cast code <serviceSigner> --rpc-url https://rpc.hemi.network/rpc   # must be 0x: the registry checks this key with ECDSA only
   ```

   An owner that returns `0x` is a plain key. Its voids are permanent and it cannot be rotated away from if it leaks, so a plain-key owner is a stop, not a note.
6. Add the address and deploy block to `DEPLOYMENTS` in `sdk/src/chains.ts`, so the CLI's `verify` uses it by default.
7. Start the service with `DEV_FREE` unset, and run the smoke test (§7) with a minimally funded agent before announcing anything.

## 6. Incidents

| Situation | Action |
|------|------|
| Service key leaked, or the service anchored something it should not have | `pause()`, then `setServiceSigner(newSigner)`, then `voidBatch(id, expectedRoot, reason)` for each bad batch, then `unpause()`. Every `BatchAttested` event names the signer, so the batches signed by the old key can be listed from logs. A voided root stays spent, and so is the exact set of receipts that produced it: the same leaves give the same root (leaves are sorted), so re-batch the legitimate receipts in a different grouping under the new key, for example split across two batches or together with newer receipts, and give each a fresh receipt file with its new batch id (`receipts verify` follows the file's batch id). |
| One bad batch | `voidBatch(batchId, expectedRoot, reason)`. It names the root it expects to void and fails loudly (`VoidTargetMismatch`) on a stale or mistyped target. |
| A batch voided by mistake | There is no undo. Re-anchor its receipts as above, in a grouping that differs from the voided one. A voided direct receipt cannot be anchored directly again (`DuplicateRun`) and not as a batch of one either (its leaf is the spent root): it comes back only inside a batch with at least one other receipt, and `batchIdOfRun` keeps naming the voided batch, so hand out a fresh receipt file. |
| Relayer out of gas | `GET /health` shows pending receipts growing and no new batches. Top up the relayer. Pending receipts batch on the next loop; nothing is lost. |
| Hemi RPC down or stalled | Expected (June 2026 outage, node rewrite in progress). Every chain call retries with backoff. The batcher and poller wait and resume. Receipts stay `pending` and are batched when the RPC returns. If a signed batch's deadline passes unmined, the batcher re-signs the same root with a new deadline; a root can never be anchored twice. Add a second RPC to `HEMI_RPC_URLS` if one is available. On testnet, do not add `hemi-testnet.drpc.org`: it is millions of blocks stale (D-6). |
| Stopping the service | Use `docker compose stop` or SIGTERM: it takes no new connections and waits up to 185 s for every paid request it has received, including one whose buyer hung up. Paid requests that arrive on a kept-alive connection meanwhile get `503 service_stopping` and are not charged. A second SIGTERM or Ctrl-C does not hurry it (the log says `already shutting down`); only SIGKILL does. A kill cuts that off, and the next start logs `a settlement was cut off` for each receipt affected. Its buyer is told to wait 30 minutes. A retry then reads the payment's nonce on chain, and pays again only if the first payment can no longer land. |
| A hold will not end | `could not read a held payment's nonce` in the log means the RPC did not answer: the receipt stays held and the next retry reads again, so fix the RPC. `its authorization can still land` means the buyer signed a long deadline: the hold ends when it passes. Nothing needs refunding in either case. |
| A used nonce the logs cannot place | `neither a transfer to PAY_TO carrying it nor a cancel was found` names the payer, nonce and blocks searched. Look the payer up on the explorer. A transfer to `PAY_TO` in those blocks means the RPC missed logs: the next retry reads again, and a second RPC in `HEMI_RPC_URLS` helps. No transfer and no cancel means the nonce was spent some other way and nothing reached `PAY_TO`: the receipt stays unserved under that run id, so tell the buyer to submit it under a new one. `the blocks to search for its transfer are too many` is a hold decided days late without a recorded head: check the explorer the same way. |
| A hold ended with no nonce to read | `a hold ran out with no authorization on record` is a receipt held since before settling recorded the nonce. A retry pays, so check `PAY_TO` for the first payment and refund a duplicate. |
| A transaction is stuck | The relayer tips at least the node's suggested priority fee (1,000,000 wei on testnet), because Hemi testnet's sequencer never mines lower tips. Check the relayer's nonce on the explorer. |
| Database lost | Receipts already anchored remain verifiable from their receipt files: verification needs only an RPC and the registry address. Restore the SQLite file from backup to keep serving `GET /receipts`. Back up `/data/receipts.sqlite` daily. |

Ownership moves in two steps: `transferOwnership(newOwner)`, then `acceptOwnership()` from the new owner. Renouncing ownership is disabled, because incident response needs an owner.

## 7. Smoke test

With the service running against the deployed registry:

```bash
export AGENT_PRIVATE_KEY=…    # the demo agent's key
node cli/dist/index.js attest examples/manifests/demo-1.json examples/manifests/demo-2.json examples/manifests/demo-3.json --wait=hemi-confirmed --out receipts/
node cli/dist/index.js status <runId>
node cli/dist/index.js verify receipts/<runId>.receipt.json --registry <address>
```

All three receipts must land in one `BatchAttested` transaction, reach `hemi-confirmed`, and verify as `valid: true` with the service stopped.

On mainnet, `scripts/mainnet-smoke.sh` runs these steps against `.secrets/mainnet.env` and the buyer in `.secrets/mainnet-agent.json`. Without arguments it only runs a read-only preflight: the registry's owner and signer, the relayer's gas, the buyer's USDC.e and the facilitator's `/supported`. `CONFIRM_MAINNET_SMOKE=yes` makes the paid run. It starts the service from `service/dist` on loopback with its own database, pays three receipts, checks the one `BatchAttested` transaction and the USDC.e that reached `PAY_TO`, stops the service and verifies each receipt.
