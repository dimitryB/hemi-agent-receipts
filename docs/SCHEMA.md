# Receipt schema, v1

This file defines every byte that is hashed, signed or anchored. The SDK implements it in `sdk/src/` and `sdk/test/schema-doc.test.ts` checks the field tables and the pinned fixture digest in this file against the SDK, so the two cannot drift.

**Freeze rule.** v1 is frozen once a ReceiptRegistry is deployed to Hemi mainnet. Any change to a field, a rule, the canonicalization or the hash bumps `receiptVersion` and gets a new section here. The registry keeps accepting old versions until the owner disables them (`setSchemaVersionEnabled`).

## 1. Manifest

A manifest is an off-chain JSON object describing one agent run. Only its hash goes on chain, together with `runId`, `agent`, `principal` and the schema version. What the hashed payloads contain is the submitter's business; the service stores a manifest only when asked to.

### 1.1 Fields

<!-- manifest-v1-fields:start -->
| Field | Type | Required | Rules |
|------|------|------|------|
| `receiptVersion` | integer | yes | Exactly `1`. On chain it is the `schemaVersion` (uint16). |
| `runId` | bytes32 | yes | 32 random bytes chosen by the client. Not zero. Unique per receipt. |
| `agent` | address | yes | The agent's account. Not the zero address. |
| `principal` | address | yes | Who the agent acted for. May equal `agent`. Not the zero address. |
| `startedAt` | integer | yes | Unix seconds. |
| `endedAt` | integer | yes | Unix seconds, not before `startedAt`. |
| `model` | string | yes | 1 to 256 characters. Model identifier, e.g. `claude-fable-5-1`. |
| `promptHash` | bytes32 | yes | Hash of the prompt. |
| `outputHash` | bytes32 | yes | Hash of the final output. |
| `toolCalls` | array<ToolCall> | yes | In execution order. May be empty. At most 10,000, though the 1 MiB limit binds first, at about 5,700. |
| `spend` | array<Spend> | yes | May be empty. At most 1,000. |
| `parentRunId` | bytes32 | no | The run this one continues. Must differ from `runId`. |
| `tags` | array<string> | no | At most 32 unique strings of 1 to 64 characters. Order is kept and hashed. |
<!-- manifest-v1-fields:end -->

**ToolCall**

<!-- toolcall-v1-fields:start -->
| Field | Type | Required | Rules |
|------|------|------|------|
| `name` | string | yes | 1 to 128 characters. |
| `argsHash` | bytes32 | yes | Hash of the call's arguments. |
| `resultHash` | bytes32 | yes | Hash of the call's result. |
| `at` | integer | yes | Unix seconds when the call was made. |
<!-- toolcall-v1-fields:end -->

**Spend**

<!-- spend-v1-fields:start -->
| Field | Type | Required | Rules |
|------|------|------|------|
| `asset` | string | yes | 1 to 256 characters. A CAIP-19 id is recommended (`eip155:743111/erc20:0x…`); a plain unit such as `usd` is allowed. |
| `amount` | decimal-string | yes | Canonical non-negative decimal, at most 78 characters. For a CAIP-19 token, base units. |
| `txHash` | bytes32 | no | The payment transaction, if there is one. |
<!-- spend-v1-fields:end -->

### 1.2 Types and spelling

There is exactly one accepted spelling of every value, so a manifest hashes to exactly one digest.

| Type | Spelling |
|------|------|
| integer | A JSON number that is a non-negative safe integer (0 to 2^53−1). |
| bytes32 | `0x` followed by 64 **lowercase** hex digits. |
| address | `0x` followed by 40 **lowercase** hex digits. EIP-55 checksums are not accepted in a manifest; `normalizeManifest` lowercases them. |
| string | A JSON string with no lone surrogates. Lengths are counted in UTF-16 code units, as JavaScript counts them. |
| decimal-string | Matches `^(0\|[1-9][0-9]*)(\.[0-9]*[1-9])?$`: no sign, no exponent, no leading zeros, no trailing fractional zeros. `"1000"`, `"0.5"` and `"0"` are valid; `"01"`, `"1.50"`, `"1e3"` and `"-1"` are not. |

Further rules:

- The object is closed. A field not listed above is rejected; new fields need a new `receiptVersion`.
- An optional field that has no value is **omitted**. `null` is rejected.
- `toolCalls` and `spend` are required even when empty (`[]`).
- The canonical form (§1.3) may be at most 1 MiB of UTF-8.

The SDK's `validateManifest` checks exactly these rules and never changes the input. `normalizeManifest` first fixes what has an unambiguous fix (hex case, members set to `undefined`) and then validates.

**Payload hash convention.** The schema only requires `promptHash`, `outputHash`, `argsHash` and `resultHash` to be 32 bytes. The SDK's `contentHash` uses keccak256 of a string's UTF-8 bytes, of a byte array's bytes, or of any other JSON value's RFC 8785 canonical form. `receipts from-trace` uses the same convention.

### 1.3 Canonicalization and the manifest hash

```
manifestHash = keccak256( UTF-8( JCS(manifest) ) )
```

JCS is RFC 8785, the JSON Canonicalization Scheme: members sorted by name compared as UTF-16 code units, no insignificant whitespace, strings and numbers serialized as ECMAScript's `JSON.stringify` does. A v1 manifest contains only strings, safe integers, arrays and objects, so number formatting never comes into play.

### 1.4 Fixture and pinned digest

`examples/manifests/fixture-v1.json` is this manifest. `sdk/test/schema-doc.test.ts` reads the JSON block below, validates it, and checks that it hashes to the pinned digest below. The digest was also reproduced independently with Python's `json.dumps(sort_keys=True, separators=(",", ":"), ensure_ascii=False)` piped to `cast keccak`, which matches JCS for this fixture.

<!-- fixture-v1:start -->
```json
{
  "receiptVersion": 1,
  "runId": "0xc394538091d41054baa94d9978dc6ff1df69c1a3b2c9feef92f8cc737549fe6d",
  "agent": "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
  "principal": "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
  "startedAt": 1793300000,
  "endedAt": 1793300042,
  "model": "claude-fable-5-1",
  "promptHash": "0xe119c207261b4b41498281159f8542fa35fb8aba3c5765e79c3622aad5e2cead",
  "outputHash": "0x646252758ce5d625d7f0d0bc25ffae7426fcecfbf26ebe6233416841e4d422cf",
  "toolCalls": [
    {
      "name": "web_search",
      "argsHash": "0x6b59c4e40fc677838fc9aebae1b36a94237de1e313209b7831bcad4d226b80ba",
      "resultHash": "0xb1b14db98415affedd717ff9934035308b2480062b2511a3b8c36ad087ee7773",
      "at": 1793300010
    },
    {
      "name": "fetch_url",
      "argsHash": "0xfaa6395d23a45d867acef7d3de5ebfb5bc3b875dd06c80375b0190b9651e3e89",
      "resultHash": "0xf6790f00856d327307073e7a9bbcf7c7fee9606c057498f38b5617ca4f2b5c5b",
      "at": 1793300025
    }
  ],
  "spend": [
    {
      "asset": "eip155:743111/erc20:0xd47971c7f5b1067d25cd45d30b2c9eb60de96443",
      "amount": "1000",
      "txHash": "0x0bca64a7f81d3472697852739ab6cb005ff5b08de82c727c997f7e137e3fb6c5"
    },
    {
      "asset": "usd",
      "amount": "0.0042"
    }
  ],
  "parentRunId": "0x7ae72dd049a4c6b29b95e8c30e8a3161ae2eed8a5fe4f78267ca307a01214d1b",
  "tags": [
    "fixture",
    "café"
  ]
}
```
<!-- fixture-v1:end -->

Pinned values for this fixture:

<!-- fixture-v1-digest:start -->
| Value | Digest |
|------|------|
| manifestHash | `0xadaa427dec949c140fb8905ead326fa55b40780c8bb8522093d6bbd065e65ff4` |
| leaf | `0x3417a283ae9026f6bf4739abba8c586f48aecfe1242050b8b8590dfaaa535e44` |
<!-- fixture-v1-digest:end -->

## 2. Receipt file

A receipt file is what a submitter keeps and hands to anyone who wants to check the claim. `receipts verify` and the SDK's `verify` need only this file, an RPC URL and the registry address. The registry address is supplied by the verifier, never trusted from the file: the file's `registry` must match it.

```json
{
  "format": "hemi-agent-receipt",
  "formatVersion": 1,
  "chainId": 743111,
  "registry": "0x…",
  "receipt": {
    "runId": "0x…",
    "manifestHash": "0x…",
    "agent": "0x…",
    "principal": "0x…",
    "schemaVersion": 1
  },
  "agentSignature": "0x…",
  "anchor": {
    "mode": "batch",
    "batchId": 7,
    "root": "0x…",
    "proof": ["0x…", "0x…"],
    "txHash": "0x…",
    "blockNumber": 7100500
  },
  "manifest": { "…": "optional; when present, verify re-hashes it" }
}
```

- `anchor` is `null` while the receipt is pending. `mode` is `batch` or `direct`; a direct attestation is a batch of one with an empty proof.
- `batchId` and `blockNumber` are JSON numbers. Hex values and addresses in a receipt file may be in any case: the file itself is never hashed, and `verify` lowercases them before use. The embedded `manifest`, which is hashed, must follow §1.2.
- The service's `GET /receipts/:runId` returns this object plus a `status` member (§7).

## 3. Leaf and Merkle tree

```
leaf = keccak256( abi.encode(bytes32 runId, bytes32 manifestHash, address agent, address principal) )
```

The leaf preimage is 128 bytes, so a leaf can never be confused with a 64-byte internal node.

The tree uses sorted-pair hashing and verifies with OpenZeppelin's `MerkleProof`:

1. Leaves are sorted ascending as 256-bit numbers, so the root does not depend on submission order. A duplicate leaf is an error.
2. Each level pairs neighbours left to right: `hashPair(a, b) = keccak256(min(a, b) ‖ max(a, b))`. An odd node at the end of a level is carried up unchanged.
3. A proof lists, bottom-up, one sibling for each level where the node has one.
4. A one-leaf tree's root is the leaf itself and its proof is empty.

All receipts in a batch share one `schemaVersion`.

## 4. Signatures (EIP-712)

Domain: `name = "HemiAgentReceipts"`, `version = "1"`, `chainId` = the Hemi chain, `verifyingContract` = the registry.

| Struct | Signed by | Type string |
|------|------|------|
| Receipt | the agent, or its principal | `Receipt(bytes32 runId,bytes32 manifestHash,address agent,address principal,uint16 schemaVersion)` |
| BatchAttestation | the service | `BatchAttestation(bytes32 root,uint32 count,uint16 schemaVersion,uint64 deadline)` |
| ServiceAttestation | the service | `ServiceAttestation(bytes32 receiptDigest,uint64 deadline)` |

- `receiptDigest` in ServiceAttestation is the agent's **full** EIP-712 digest (`0x1901 ‖ domainSeparator ‖ structHash`), not the struct hash. This is proofOfPatience's VerifierAttestation pattern. It domain-separates the two signatures, so one signature can never satisfy both checks.
- The registry accepts an agent signature from `agent` or from `principal`. EOAs are checked with ECDSA. A deployed contract wallet is checked with EIP-1271 through OpenZeppelin's `SignatureChecker`.
- `deadline` bounds how long a service signature can be submitted: it must be in the future and at most `MAX_DEADLINE_WINDOW` (1 hour) ahead of the block that includes it. The agent's signature has no deadline; replay is stopped by `runId` and root uniqueness instead.
- Browser wallets sign with `eth_signTypedData_v4`. `serializeReceiptTypedData` declares `EIP712Domain` explicitly, because otherwise viem serializes `domain: {}` and the signature never verifies (the proofOfPatience fix).

## 5. ReceiptRegistry interface

`contracts/contracts/ReceiptRegistry.sol`, Solidity 0.8.28, OpenZeppelin 5.4.0, `Ownable2Step` and `Pausable`. Not upgradeable. The SDK's ABI (`sdk/src/abi.ts`) is checked against the compiled artifact.

```solidity
struct Receipt { bytes32 runId; bytes32 manifestHash; address agent; address principal; uint16 schemaVersion; }
struct Batch   { bytes32 root; uint32 count; uint16 schemaVersion; bool voided; address serviceSigner; uint64 attestedAt; uint64 blockNumber; }

// Anchoring. Anyone may submit; the service signature is what authorizes.
function attestBatch(bytes32 root, uint32 count, uint16 schemaVersion, uint64 deadline, bytes serviceSignature) returns (uint256 batchId);
function attest(Receipt receipt, bytes agentSignature, uint64 deadline, bytes serviceSignature) returns (uint256 batchId);

// Verification. Free to call; works while paused.
function verifyInclusion(uint256 batchId, bytes32 leaf, bytes32[] proof) view returns (bool);
function verifyReceipt(uint256 batchId, Receipt receipt, bytes32[] proof) view returns (bool);
function leafHash(bytes32 runId, bytes32 manifestHash, address agent, address principal) pure returns (bytes32);
function receiptDigest(Receipt receipt) view returns (bytes32);
function serviceAttestationDigest(bytes32 receiptDigest, uint64 deadline) view returns (bytes32);
function batchAttestationDigest(bytes32 root, uint32 count, uint16 schemaVersion, uint64 deadline) view returns (bytes32);
function getBatch(uint256 batchId) view returns (Batch);
function batchCount() view returns (uint256);
function batchIdOfRoot(bytes32 root) view returns (uint256);   // 0 = never anchored
function batchIdOfRun(bytes32 runId) view returns (uint256);   // direct path only; 0 = unused
function serviceSigner() view returns (address);
function schemaVersionEnabled(uint16 version) view returns (bool);
uint64 constant MAX_DEADLINE_WINDOW = 1 hours;
uint32 constant MAX_BATCH_COUNT = 65_536;

// Administration, owner only.
function pause(); function unpause();
function voidBatch(uint256 batchId, bytes32 expectedRoot, string reason);
function setServiceSigner(address newSigner);                    // never the zero address or the owner
function setSchemaVersionEnabled(uint16 version, bool enabled);
function transferOwnership(address newOwner); function acceptOwnership();   // Ownable2Step; never to the service signer
function renounceOwnership();                                    // always reverts: incident response needs an owner

event BatchAttested(uint256 indexed batchId, bytes32 indexed root, address indexed serviceSigner, uint32 count, uint16 schemaVersion);
event ReceiptAttested(bytes32 indexed runId, address indexed agent, address indexed principal, bytes32 manifestHash, uint256 batchId, uint16 schemaVersion);
event BatchVoided(uint256 indexed batchId, bytes32 indexed root, string reason);
event ServiceSignerUpdated(address indexed previousSigner, address indexed newSigner);
event SchemaVersionSet(uint16 indexed version, bool enabled);
```

Behaviour:

- **Batch ids** start at 1 and increase by one. A direct attestation creates a batch of one whose root is the leaf, and emits both `BatchAttested` and `ReceiptAttested`.
- **Replay.** A root can be anchored once (`RootAlreadyAttested`). A run id can be attested on the direct path once (`DuplicateRun`). Run-id uniqueness inside batches is enforced by the service, because the contract only sees the root.
- **Checks** in this order: field sanity, schema version enabled, deadline window, replay, then signatures. Field sanity means a non-zero `root` and a `count` from 1 to `MAX_BATCH_COUNT` for a batch (`InvalidBatch`), and a non-zero `runId`, `manifestHash`, `agent` and `principal` for a receipt (`InvalidReceipt`).
- **Signatures** must be 65 bytes (`r ‖ s ‖ v`); the 64-byte EIP-2098 form is rejected. An agent or principal account that has code is checked only through EIP-1271, never by ECDSA.
- **Who signed is not recorded.** The contract accepts the agent's or the principal's signature but stores neither the signature nor which of the two signed, and `ReceiptAttested` names both addresses without saying who signed. `agent`, in events and in `Batch`, is the named agent, not the signer: a principal can anchor a receipt that names an agent which never signed. A verifier learns the signer from the receipt file's signature (`verify` reports it as `signer.role`), never from the chain.
- **Unknown batch ids.** `getBatch` reverts `UnknownBatch` for an id that was never issued, including 0. `verifyInclusion` and `verifyReceipt` return false instead of reverting.
- **Owner and signer stay apart** through every path: the constructor, `setServiceSigner`, `transferOwnership`, and again when `acceptOwnership` completes, in case the signer was rotated onto the pending owner in between.
- **Void.** `voidBatch` names the batch and the root it expects to void, and fails loudly on a mismatch (`VoidTargetMismatch`), as proofOfPatience's targeted void does. A voided batch's root stays spent. `verifyInclusion` and `verifyReceipt` return false for a voided batch.
- **Pause** stops both anchoring functions. Every read keeps working.
- **Events** carry every stored field, so an indexer can rebuild all batches from logs alone. `Batch.blockNumber` lets a verifier read the anchoring event with a one-block `eth_getLogs`, which every Hemi RPC serves.

Custom errors: `InvalidServiceSigner`, `InvalidReceipt`, `InvalidBatch`, `SchemaVersionDisabled(uint16)`, `ExpiredSignature(uint64)`, `DeadlineTooDistant(uint64)`, `DuplicateRun(bytes32, uint256)`, `RootAlreadyAttested(bytes32, uint256)`, `InvalidAgentSignature`, `InvalidServiceSignature`, `UnknownBatch(uint256)`, `BatchAlreadyVoided(uint256)`, `VoidTargetMismatch(bytes32, bytes32)`, `RenounceDisabled`.

## 6. Trace JSONL (input to `receipts from-trace`)

One JSON object per line. Blank lines are ignored. Exactly one `run` line comes first and exactly one `end` line comes last.

| `type` | Fields | Becomes |
|------|------|------|
| `run` | `agent`, `model`, `startedAt`; optional `principal` (defaults to `agent`), `runId` (defaults to 32 random bytes), `parentRunId`, `tags`; `prompt` (hashed with `contentHash`) or `promptHash` | the manifest header |
| `tool_call` | `name`, `at`; `args` or `argsHash`; `result` or `resultHash` | one `toolCalls` entry, in file order |
| `spend` | `asset`, `amount`; optional `txHash` | one `spend` entry |
| `end` | `endedAt`; `output` or `outputHash` | `endedAt`, `outputHash` |

Command-line flags (`--agent`, `--principal`, `--model`, `--run-id`) override the `run` line. `examples/trace.jsonl` is a working example.

## 7. Status

A receipt moves only forward along this ladder:

| Stage | Meaning |
|------|------|
| `pending` | Accepted by the service, waiting for its batch to be anchored. |
| `hemi-included` | The anchoring transaction is mined. |
| `hemi-confirmed` | The anchoring block is at or below Hemi's `safe` head, has at least N blocks on top (`HEMI_CONFIRMATIONS`, default 10), and is still canonical. |
| `btc-published` | The keystone covering the anchoring block has a PoP transaction in a Bitcoin block. |
| `btc-final` | That publication has at least 9 Bitcoin confirmations (`tip − height + 1`), per Hemi's PoP docs. |

`voided` is a terminal state outside the ladder: the owner voided the batch.

The status object (`StatusInfo` in `sdk/src/types.ts`) says how the Bitcoin stages were determined. `btc.source` is `bitcoin` (a PoP transaction carrying the canonical keystone was found on Bitcoin), `estimate` (PoP is live but the keystone is not found yet; expected times only), or `unavailable` (no data source, or no PoP activity, with the reason in `btc.detail`). Only `bitcoin` data advances a receipt to `btc-published` or `btc-final`; an estimate never does. How the stages are read is recorded in `docs/DECISIONS.md` D-4.
