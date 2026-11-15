# contracts

`ReceiptRegistry` anchors hashes of signed AI-agent run manifests on Hemi and proves them later. It implements `docs/SCHEMA.md` §3 to §5 exactly; the SDK's ABI (`sdk/src/abi.ts`) and hashing code are tested against it.

- **Batch path, `attestBatch`.** The service builds a sorted-pair Merkle tree of receipt leaves off chain, signs a `BatchAttestation(root, count, schemaVersion, deadline)` and anyone submits it. The contract stores the root.
- **Direct path, `attest`.** One receipt, anchored as a batch of one whose root is the leaf. The contract checks the agent's (or its principal's) EIP-712 signature over the `Receipt` struct, using ECDSA for an EOA and EIP-1271 for a contract wallet. It also checks the service's `ServiceAttestation`, which commits to the agent's full digest.
- **Verification.** `verifyReceipt(batchId, receipt, proof)` and `verifyInclusion(batchId, leaf, proof)` are free view calls. They keep working while the contract is paused and return false for an unknown or voided batch.
- **Administration.** `Ownable2Step` and `Pausable`. The owner can pause both writes, void a batch by naming its root (the root stays spent), rotate the service signer and enable or disable schema versions. The owner and the service signer are always different accounts, and ownership cannot be renounced.

The trust model is written out in the contract's NatSpec. In short: on the batch path the contract only sees a root, so the service is trusted to batch honestly. Both signatures bind every stored field, so a relayer cannot change what gets recorded. On the direct path the contract accepts the agent's or the principal's signature and records neither, so `ReceiptAttested.agent` is the named agent, not necessarily the signer; the receipt file says who signed.

## Layout

| Path | What |
|------|------|
| `contracts/ReceiptRegistry.sol` | The registry. Solidity 0.8.28, OpenZeppelin 5.4.0, EVM target `paris`. |
| `contracts/utils/SignatureCheckerParis.sol` | OZ 5.4.0's `SignatureChecker.isValidSignatureNow` and `isValidERC1271SignatureNow`, copied verbatim (see below). |
| `contracts/mocks/ERC1271WalletMock.sol` | Test-only EIP-1271 wallet. |
| `ignition/modules/ReceiptRegistry.ts` | Ignition module `ReceiptRegistryModule`, parameters `owner` and `serviceSigner`. |
| `ignition/parameters/*.example.json` | Placeholder parameter files for testnet and mainnet. |
| `scripts/check-deploy-params.mjs` | Pre-deploy guard for a parameter file. |
| `test/ReceiptRegistry.ts` | Behaviour: both paths, events, replay, signatures, EIP-1271, deadlines, schema versions, check order, pause, void, signer rotation, ownership. |
| `test/cross-implementation.ts` | SDK ↔ contract agreement: Merkle proofs for tree sizes 1–9, 16, 17 and 64; leaf, digests and type hashes; the SCHEMA.md fixture's pinned leaf; SDK-produced and `eth_signTypedData_v4` signatures accepted on chain. |
| `test/abi-parity.ts` | `sdk/src/abi.ts` compared in both directions with the compiled ABI. |
| `test/ignition-module.ts`, `test/gas.ts` | The Ignition module deploys; gas numbers below. |

## Compile and test

Run npm from the repository root. Its `.npmrc` points at the public registry.

```sh
npm run compile -w contracts     # hardhat compile --build-profile production
npm test -w contracts            # hardhat test nodejs --build-profile production
npm run typecheck -w contracts   # tsc over tests, config and the Ignition module
```

The tests import `@hemi-receipts/sdk` from `sdk/dist`, so build the SDK first (`npm run build -w sdk`) whenever its source has changed.

Compiling writes the artifact to `contracts/artifacts/contracts/ReceiptRegistry.sol/ReceiptRegistry.json`, with `abi` and `bytecode`. `e2e/lib/deploy.ts` loads it from that path. The `production` profile turns the optimizer on (200 runs), and tests and deployments use the same bytecode.

## Deploy

The constructor takes `(address initialOwner, address initialServiceSigner)`. The contract is not upgradeable. Use a multisig or hardware wallet as the owner, and keep the service signer key on the service only.

1. Copy the example parameter file, `ignition/parameters/hemi-testnet.example.json` to `hemi-testnet.json` or `hemi-mainnet.example.json` to `hemi-mainnet.json`, and fill in real addresses.
2. Check it: `node contracts/scripts/check-deploy-params.mjs contracts/ignition/parameters/hemi-testnet.json`. The check rejects placeholders, the zero address, invalid or mis-checksummed addresses and `owner == serviceSigner`. It also notes addresses that are not checksummed. For a file whose name contains `mainnet`, it refuses unless `CONFIRM_MAINNET_DEPLOY=yes` is set.
3. Provide the config variables, either as environment variables or with `npx hardhat keystore set <NAME>` run from `contracts/`:
   - testnet (chain 743111): `HEMI_TESTNET_RPC_URL`, `HEMI_TESTNET_DEPLOYER_PRIVATE_KEY`
   - mainnet (chain 43111): `HEMI_RPC_URL`, `HEMI_DEPLOYER_PRIVATE_KEY`
4. Deploy and verify on Blockscout. Each script runs the parameter check first:

   ```sh
   npm run deploy:testnet -w contracts
   CONFIRM_MAINNET_DEPLOY=yes npm run deploy:hemi -w contracts
   ```

Verification uses Blockscout only (`explorer.hemi.xyz`, `testnet.explorer.hemi.xyz`). Etherscan and Sourcify are disabled.

## Gas

Each figure is `gasUsed` from the transaction receipt, measured by `test/gas.ts` on Hardhat's simulated network with the production profile. Values move by about ±20 gas from run to run, because signature bytes vary.

| Call | gasUsed |
|------|--------:|
| `attestBatch`, first batch on a new registry | 149,782 |
| `attestBatch`, any later batch (any `count`) | 132,694 |
| `attest`, first receipt on a new registry (agent-signed) | 187,665 |
| `attest`, signed by the agent (EOA) | 170,565 |
| `attest`, signed by the principal (EOA) | 177,233 |
| `attest`, agent is an EIP-1271 wallet | 175,298 |

`attestBatch` costs the same whatever the leaf count, so a batch of 1,000 receipts costs about 133 gas per receipt. Most of the cost is the three new storage slots of a `Batch` and the `batchIdOfRoot` entry.

## Implementation notes

- **`SignatureCheckerParis`.** OZ 5.4.0's `SignatureChecker.sol` also contains an ERC-7913 overload that imports `Bytes.sol`. That file uses the Cancun-only `mcopy` opcode, so it does not compile for `paris`. The two functions the registry uses are copied unchanged into `contracts/utils/SignatureCheckerParis.sol`.
- **Unknown batches.** `getBatch` reverts with `UnknownBatch(id)` for an id that was never issued. `verifyInclusion` and `verifyReceipt` return `false` instead of reverting.
- **Signature encoding.** The service signature is checked with `ECDSA.tryRecover`. Any failure, including malformed bytes, a high-s value or a 64-byte EIP-2098 signature, reverts with `InvalidServiceSignature`. Agent signatures must also be 65 bytes for an EOA.
- **`verifyInclusion` accepts any tree node,** including an internal node with a shorter proof. Prove receipts with `verifyReceipt`: it derives the leaf from a 128-byte preimage, so it cannot be given an internal node.
- **Owner/signer separation is also enforced on `acceptOwnership`.** Without that check, the signer could be rotated onto the pending owner between the two ownership steps.
- **Field sanity on the direct path** rejects a zero `runId`, `manifestHash`, `agent` or `principal` with `InvalidReceipt`.
- **One compiler warning is expected.** The parameter `receiptDigest` of `serviceAttestationDigest` shadows the function `receiptDigest`. The name is kept because SCHEMA.md §5 and the SDK ABI use it.
