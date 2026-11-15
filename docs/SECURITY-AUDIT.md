# Security audit of the contracts

Date: 2026-11-09. Scope: the contracts in this repository, which have not changed since. Reviewer: Claude (Fable 5.1), an AI model, on request. This is a careful internal review, not an independent third-party audit, and it should not be presented as one.

## Scope

| File | Lines | Role |
|------|------:|------|
| `contracts/contracts/ReceiptRegistry.sol` | 439 | The registry: batch and direct anchoring, verification, administration |
| `contracts/contracts/utils/SignatureCheckerParis.sol` | 44 | Two OpenZeppelin 5.4.0 `SignatureChecker` functions, vendored for the `paris` EVM target |
| `contracts/contracts/mocks/ERC1271WalletMock.sol` | 35 | Test-only EIP-1271 wallet, never deployed |

Toolchain: Solidity 0.8.28 (pinned), OpenZeppelin Contracts 5.4.0, EVM target `paris`, optimizer on at 200 runs. Not upgradeable.

Out of scope: the service, SDK, CLI and viewer, except where their behaviour decides whether a contract property matters. Those places are named below.

## Method

1. Every line of the three files read against `docs/SCHEMA.md` §3 to §5 and the trust model in the contract's NatSpec.
2. Slither 0.11.6, 102 detectors, run on `ReceiptRegistry.sol` with the OpenZeppelin remapping and `--evm-version paris`.
3. The contract test suite, `npm test -w contracts`: 57 tests, all passing, 776 ms.
4. Five temporary probe tests written for this review, run once and deleted (results under "Evidence"). Nothing was added to the suite.
5. The two vendored functions compared token by token with OpenZeppelin 5.4.0's `SignatureChecker.sol`: identical.
6. The testnet deployment read back from the public RPC, and the source and bytecode recorded by Ignition compared with the checkout.

## Result

No way was found for anyone to anchor, void or alter a record without the key the design says is needed, and no way for a valid signature to be reused somewhere it was not meant for. Replay, cross-chain replay, signature malleability, confusion between the three EIP-712 structs, internal Merkle nodes presented as leaves, reentrancy and the owner/signer separation were each checked and hold.

Nothing rated Critical, High or Medium. Two Low findings concern recovery after a mistaken void and the reach of the owner key. The rest is informational: design choices that are sound but whose consequences deserve a sentence in the runbook or in the verifier's output.

## Findings

### L-1. A void cannot be undone, and recovery needs a different leaf set

`voidBatch` is permanent, by design: the root stays spent so a bad batch cannot be re-anchored. The same rule applies to a batch voided by mistake, and the recovery path is narrower than RUNBOOK §6 ("re-batch legitimate receipts under the new key") suggests:

- The exact leaf set of a voided batch produces the same root (leaves are sorted, so order does not help) and is refused forever with `RootAlreadyAttested`, under the old signer or a new one (probe P2). The receipts come back only in a batch whose leaf set differs, for example two batches, or one batch with at least one more receipt.
- A voided direct-path receipt cannot be anchored directly again (`DuplicateRun`), and not as a batch of one either (its leaf is the spent root). It comes back only inside a batch with at least one other leaf (probe P1). `batchIdOfRun` keeps pointing at the voided batch; the receipt file's `batchId` must be updated to the new batch, and verifiers that only consult `batchIdOfRun` would wrongly conclude the receipt is void.

No code change is recommended. An `unvoid` would weaken the one guarantee a void gives. Recommendation: say in RUNBOOK §6 that a re-anchor after a void must use a leaf set that differs from the voided one, and that a direct receipt comes back only inside a multi-leaf batch with a fresh receipt file.

### L-2. The owner key is the one unrecoverable key

A compromised or mistaken owner can void every batch and pause both writes. Voids are permanent (L-1), so an owner-key compromise is a permanent loss of verifiability for every receipt anchored so far, with no on-chain limit (no timelock, no second approver, no cap on voids). Pausing and signer rotation are reversible; voiding is not.

The contract already does what it can: `Ownable2Step`, no renounce, owner never equal to the signer, and `voidBatch` needs the exact root. RUNBOOK §1 and §5 call for a hardware wallet or multisig on mainnet. On testnet the owner (`0xD572…21e0`) is an EOA (no code), which is fine for testnet.

Recommendation: make the multisig a verified step of the mainnet go-live in RUNBOOK §5 (read `cast code <owner>` back and expect a non-empty result), since this is the only key whose compromise cannot be rotated away from. A timelock on `voidBatch` is not recommended: voiding is the incident response and must be fast.

### I-1. A principal can anchor a receipt naming any agent, and the chain does not record who signed

`_isValidAgentSignature` accepts the agent or the principal, as D-3 decides. So any account can anchor a receipt that names an arbitrary `agent` address and itself as `principal`, with no involvement of that agent (probe P3). The stored `Batch` and the `ReceiptAttested` event carry the agent and principal addresses but not which of them signed, so an indexer working from logs alone cannot tell a receipt the agent signed from one its principal signed on its behalf. The SDK's `verify` does report `signer.role` from the receipt file.

This is the intended semantics (a principal vouching for its agent's run), not a bug. Recommendation: treat `ReceiptAttested.agent` as "the named agent", never as "the signer", in the viewer, any indexer and any reputation use; show the signer's role prominently. If the contract is ever redeployed, consider adding the recovered signer to `ReceiptAttested`.

### I-2. `setServiceSigner` accepts an address that has code

The service signature is checked with ECDSA only, so a signer with code can never authorize a write (probe P4). The owner would notice at the first failed anchor and rotate again; nothing is lost. A `code.length == 0` check would also exclude EIP-7702-delegated EOAs, so it is not clearly better. Recommendation: none beyond a line in RUNBOOK §6 that the service signer must be a plain EOA.

### I-3. The batch path trusts the service, as documented

On `attestBatch` the contract sees a root and a count. It cannot check that `count` is true, that every leaf carries a valid agent signature, that a run id is not in two batches, or that the schema version matches the receipts. The same receipt can be anchored in a batch and directly, since the direct path only checks whether the leaf was used as a root. A compromised service key can anchor arbitrary roots until the owner rotates it; the incident path in RUNBOOK §6 (pause, rotate, void by root, unpause) works and `BatchAttested` names the signer so bad batches can be listed. All of this is stated in the contract's NatSpec and SCHEMA §5. No change recommended.

### I-4. Off-chain and on-chain disagree on accounts that have code

The contract checks an account with code only through EIP-1271, never ECDSA. The service's `verifyAgentSignature` (`service/src/input.ts`) and the SDK's `verify` try ECDSA first, regardless of code. For an EIP-7702-delegated EOA this means the service could countersign a direct-path receipt that the chain then rejects with `InvalidAgentSignature`. The key did sign, so nothing false is accepted; it is a liveness difference on the direct path only, and it needs 7702 on Hemi to matter. Recommendation: have the service skip ECDSA when the candidate has code, mirroring the contract.

### I-5. Agent signatures never expire and EOAs cannot revoke them

The `Receipt` struct has no nonce or deadline; replay is prevented by root and run-id uniqueness. An agent that has signed a receipt has no on-chain way to stop the service from anchoring it later. Stated in SCHEMA §4. Consistent with the design, where the agent wants the anchor.

### I-6. Static analysis

Slither reported 7 results, all informational and all expected:

| Detector | Where | Assessment |
|------|------|------|
| incorrect-equality | `verifyReceipt`, `schemaVersion ==` | Exact match is the intent |
| unused-return (2) | `ECDSA.tryRecover` third value | `errArg` is deliberately ignored; the error code is checked |
| shadowing-local | parameter `receiptDigest` | Documented in the contracts README; name kept to match SCHEMA §5 and the ABI |
| timestamp (2) | `_checkDeadline`, and a false positive on `verifyReceipt` | The one-hour window is the design; sequencer drift of seconds is immaterial |
| low-level-calls | `staticcall` in the vendored OZ code | Identical to OpenZeppelin |

No detector fired for reentrancy, arbitrary calls, delegatecall, selfdestruct, `tx.origin`, uninitialized storage or unchecked arithmetic. The project code contains no assembly.

## Checked and found sound

- **Replay.** A root anchors once; a run id anchors once on the direct path; a leaf cannot be both a direct root and a batch root. The deadline window is inclusive at both ends and rejects one second outside (probe P5).
- **Cross-chain and cross-contract replay.** The EIP-712 domain binds `chainId` and `verifyingContract`; OpenZeppelin rebuilds the separator if the chain id changes.
- **Type separation.** Three distinct type hashes. `ServiceAttestation` commits to the agent's full digest, so no single signature satisfies both checks even when agent and service are one key (tested).
- **Malleability.** Only 65-byte, low-s signatures recover; the EIP-2098 form and the mirrored-s form are rejected (tested). Uniqueness does not depend on signature bytes anyway.
- **Merkle.** Leaf preimages are 128 bytes, internal nodes 64, so an internal node cannot pass as a receipt in `verifyReceipt`. `verifyInclusion` accepts internal nodes by documented design. The SDK sorts leaves, rejects duplicates and carries odd nodes up unchanged, so two leaf sets never share a root.
- **Reentrancy and value.** The only external call is a `staticcall` to an EIP-1271 wallet, made before any state is written. No ETH, no tokens, no `receive`.
- **Access control.** Every admin function is `onlyOwner`; ownership moves in two steps; renounce reverts; owner and signer are kept apart in the constructor, `setServiceSigner`, `transferOwnership` and `_transferOwnership` (so a signer rotated onto the pending owner blocks `acceptOwnership`; tested).
- **Pause.** Gates both writes; reads and `voidBatch` keep working.
- **Arithmetic and storage.** Solidity 0.8 checked math; `uint64` timestamp and block casts are safe; `Batch` packs into three slots as the gas table expects.
- **Front-running.** Anyone may copy a relayer's transaction; the result is identical and the signatures bind every stored field. The service's batcher treats `RootAlreadyAttested` and a non-zero `batchIdOfRoot` as success (`service/src/batcher.ts`).
- **Vendored code.** Both functions in `SignatureCheckerParis.sol` are identical to OpenZeppelin 5.4.0.
- **Deployment.** Testnet readback on 2026-11-09: owner `0xD572…21e0`, pending owner zero, signer `0xdd80…EA39` (an EOA), not paused, 21 batches, schema 1 enabled, schema 2 disabled, window 3600, max count 65536. The source Ignition recorded for the testnet deployment is identical to the checkout, and the committed Ignition artifact's creation bytecode is identical to a fresh production-profile compile. `.env`, `.secrets/` and `hemi-mainnet.json` are gitignored and untracked. `scripts/check-deploy-params.mjs` refuses placeholders, the zero address, `owner == serviceSigner` and an unconfirmed mainnet file.

## Evidence

Probe tests written for this review (Hardhat, production profile, all passing; the file was deleted afterwards):

| Probe | What it showed |
|------|------|
| P1 | After `voidBatch` of a direct receipt: `attest` again reverts `DuplicateRun`; `attestBatch` of the leaf as a one-leaf root reverts `RootAlreadyAttested`; a two-leaf batch containing the leaf anchors and `verifyReceipt` is true against it; `batchIdOfRun` still names the voided batch |
| P2 | After voiding a three-leaf batch and rotating the signer, the same three leaves (same root) are refused with `RootAlreadyAttested` |
| P3 | A principal anchors a receipt naming an agent that never signed; `getBatch` exposes no signer role |
| P4 | `setServiceSigner(address(registry))` succeeds |
| P5 | Deadlines of `now` and `now + 3600` pass; `now + 3601` reverts `DeadlineTooDistant`; `now - 1` reverts `ExpiredSignature` |

Slither invocation (from `contracts/`, using the solc 0.8.28 binary Hardhat cached):

```
slither contracts/ReceiptRegistry.sol --solc <solc-0.8.28> \
  --solc-remaps "@openzeppelin/contracts/=<repo>/node_modules/@openzeppelin/contracts/" \
  --solc-args "--evm-version paris" --exclude-dependencies --filter-paths node_modules
```

## Follow-ups, applied 2026-11-09

All five were applied the same day, none of them in the contract:

1. **L-1.** RUNBOOK §6 now says that a re-anchor after a void must use a grouping that differs from the voided one, and has a row for a batch voided by mistake: a direct receipt comes back only inside a multi-leaf batch, with a fresh receipt file, since `batchIdOfRun` keeps naming the voided batch.
2. **L-2.** RUNBOOK §5 reads `cast code` back for the owner (must have code: a multisig) and the service signer (must not) before go-live, and §1 states why: the owner's voids are permanent and it cannot be rotated away from.
3. **I-1.** SCHEMA §5 and the contracts README state that the chain does not record who signed and that `agent` is the named agent. The viewer's verdict and "Signed by" row, and `receipts verify`, now say "not by the agent" when the principal signed.
4. **I-4.** The service accepts an ECDSA match only from an account without code; an account with code is checked through EIP-1271, as the contract does (`service/src/input.ts`, `CodeCache`). Code lookups are cached for ten minutes and share the existing rate limit; when the limit is spent or the RPC does not answer, an ECDSA match is accepted as before, so no request that succeeded before fails now. Covered by a new test in `service/test/attest-idempotency.test.ts` that gives fresh EOAs code with `anvil_setCode`.
5. **I-2.** RUNBOOK §1 and §5: the service signer must be a plain EOA.
