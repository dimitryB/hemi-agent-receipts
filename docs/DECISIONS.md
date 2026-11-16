# Decisions

Every design decision for the receipts MVP, and every verify-first item from its design brief (not part of this repository) with the command that settled it and its output. Outputs are trimmed but real. Entries are numbered `D-n` and never renumbered.

All reads below were run on 2026-10-29 and 2026-10-30 unless an entry says otherwise. The build machine's network could not reach `explorer.hemi.xyz` (the TLS handshake for that hostname failed), so mainnet values come from the RPC and from Hemi's token list, and testnet values from the RPC and `testnet.explorer.hemi.xyz`:

```
$ curl -sS https://explorer.hemi.xyz/api/v2/stats -o /dev/null -w "%{http_code}"; echo " exit $?"
curl: (35) LibreSSL/3.3.6: error:1404B42E:SSL routines:ST_CONNECT:tlsv1 alert protocol version
000 exit 35
$ curl -s https://testnet.explorer.hemi.xyz/api/v2/stats | jq -c '{total_blocks, average_block_time}'
{"total_blocks":"6063471","average_block_time":1.2E+4}
```

From 2026-11-09 the same network failed the handshake for `testnet.explorer.hemi.xyz` as well. The mainnet explorer reads in D-7 and D-14 were therefore made in a browser.

## Verify-first results

| Item | Mainnet (`eip155:43111`) | Testnet (`eip155:743111`) | Entry |
|------|------|------|------|
| Chain ID | 43111 | 743111 | D-6 |
| Explorer | `https://explorer.hemi.xyz`: unreachable from the build machine's network; read in a browser | `https://testnet.explorer.hemi.xyz`: answers; used for token records and source verification | intro, D-10 |
| Public RPC answers | yes | yes | D-6 |
| dRPC answers | yes, in sync | yes, but about 2.66 million blocks stale | D-6 |
| `eth_getLogs` range limit | public: none hit at 10,000; dRPC free: 100 works, 2,000 refused | public: 1,000,000 blocks accepted; dRPC free: every range refused | D-6 |
| USDC.e address | `0xad11a8BEb98bbf61dbb1aa0F6d6F2ECD87b35afA` | `0xD47971C7F5B1067d25cd45d30b2c9eb60de96443` | D-7 |
| USDC.e implements EIP-3009 | **yes** | **no** | D-7 |
| USDC.e implements EIP-2612 | **yes** | **no** | D-7 |
| hemiBTC address | `0xAA40c0c7644e0b2B224509571e10ad20d9C4ef28` | none; the tunnel's BTC is hBTC `0x36Ab5Dba83d5d470F670BC4c06d7Da685d9afAe7` | D-7 |
| Permit2 at `0x000000000022D473030F116dDEE9F6B43aC78BA3` | deployed | deployed (by the x402 facilitator project, 2026-10-29) | D-7 |
| hBK contract | `0x7007dd1C09527B92AEcd8Ae6570B73d09E0B8F12` has code | `0xeC9fa5daC1118963933e1A675a4EEA0009b7f215` has code | D-8 |
| hBK precompiles | `0x40`–`0x46` per docs; `0x44` (BtcLastHeader) and `0x43` (tx confirmations) answer | same; `0x44` and `0x43` answer | D-8 |
| hBK ABI | `IBitcoinKit` per docs; `getLastHeader()` decodes on mainnet | `getLastHeader()` reverts on testnet's hBK; the precompiles answer | D-8 |
| CAIP-2 ids (x402 networks) | `eip155:43111`, used in the paywall | `eip155:743111`, used in the paywall | D-7, D-12 |
| Testnet faucet / tunnel page | n/a | answers HTTP 200; tunneling needs a person | D-9 |
| Infura/DIN endpoints | not used: they need an API key; public RPC and dRPC cover the need | same | D-6 |
| Testnet gas obtainable | n/a | yes, through Sepolia and the Hemi tunnel; funded by hand for this build | D-9 |
| Registry deployed and source verified | `0x95127A8aCa9B5c235C56A2dfd315a567Ef545A40`, deployed 2026-11-13; source verified (exact match) | `0xef9Bb805581c0E947DEA54052Ad360485c3F73Fe` | D-10, D-14 |
| Reading btc-published / btc-final | from Bitcoin data via the rebuilt keystone; verified | not reachable: no PoP on testnet; reported as unavailable, with the reason | D-4 |

---

## D-1. Manifest schema v1

**Decision.** The manifest is off-chain JSON with the fields the brief lists, defined byte-exactly in [SCHEMA.md](SCHEMA.md) §1. It is canonicalized with RFC 8785 (JCS) and hashed with keccak256 over the UTF-8 bytes. On chain go only `manifestHash`, `runId`, `agent`, `principal` and the schema version.

**Why each rule exists.** Whatever can be spelled two ways would hash two ways, so the schema allows one spelling of everything:

- **Hex is lowercase**, addresses included. EIP-55 checksums carry no meaning in a hash, and accepting both cases would let one run produce two digests. `normalizeManifest` lowercases user input; `validateManifest` rejects anything not already canonical.
- **Optional fields are omitted, never `null`.** In JCS, `{"a":null}` and `{}` are different documents.
- **Integers only, and only safe integers.** JCS number formatting then never matters, and every language can read the values exactly. Amounts are decimal strings for the same reason (`"1000"`, never `1e3` or `1000.0`).
- **The object is closed.** An unknown field is rejected, so a v1 verifier never hashes fields it does not understand. New fields mean `receiptVersion` 2.
- **Payload contents stay off the schema.** Prompts, outputs, tool arguments and results appear only as 32-byte hashes. The SDK's `contentHash` convention (keccak256 of UTF-8, or of the JCS form of a JSON value) is a convenience, not a rule.

**Evidence that the canonical form is what we think it is.** The fixture in SCHEMA.md §1.4 was hashed by the SDK and, independently, by Python's `json.dumps` and `cast keccak`:

```
$ npx tsx mkfixture.ts            # SDK: canonicalize + keccak256
manifestHash: 0xadaa427dec949c140fb8905ead326fa55b40780c8bb8522093d6bbd065e65ff4
leaf: 0x3417a283ae9026f6bf4739abba8c586f48aecfe1242050b8b8590dfaaa535e44
$ python3 -c 'import json; m=json.load(open("examples/manifests/fixture-v1.json")); print(json.dumps(m,sort_keys=True,separators=(",",":"),ensure_ascii=False))' > canon.txt
$ cast keccak "$(cat canon.txt)"
0xadaa427dec949c140fb8905ead326fa55b40780c8bb8522093d6bbd065e65ff4
```

The fixture includes a non-ASCII tag (`café`), so UTF-8 handling is exercised. The SDK's RFC 8785 test vectors (`sdk/test/canonicalize.test.ts`) cover escaped control characters, newlines and UTF-16 key ordering. `sdk/test/schema-doc.test.ts` re-checks this digest and the SCHEMA.md field tables against the SDK on every test run.

## D-2. Batching

**Decision.** The contract stores one Merkle root per batch. The service closes a batch at 64 receipts or 60 seconds after the oldest pending receipt, whichever comes first (`BATCH_MAX_SIZE`, `BATCH_MAX_WAIT_SECONDS`). A receipt is proven by its inclusion proof plus the batch's transaction. Hashing is sorted-pair (OpenZeppelin `MerkleProof`), and `leaf = keccak256(abi.encode(runId, manifestHash, agent, principal))`, both exactly as the brief specifies.

**Details settled here.**

- **Leaves are sorted before building**, so the root does not depend on arrival order, and an odd node is carried up unchanged rather than duplicated. Duplicating the last node, as some libraries do, makes two different leaf sets share a root.
- **No second preimage risk from the leaf format.** The leaf preimage is 128 bytes and an internal node's is 64, so an internal node cannot be presented as a leaf. OpenZeppelin's `StandardMerkleTree` double-hashes leaves to get the same property for 64-byte leaves; ours does not need it. The contract also offers `verifyReceipt`, which computes the leaf itself, so on-chain callers never pass a raw leaf.
- **A direct attestation is a batch of one.** `attest(receipt, agentSig, deadline, serviceSig)` stores a batch whose root is the leaf, with an empty proof. Verification, voiding and status then work the same way for both paths. It also emits `ReceiptAttested`, so the direct path is indexable per receipt.
- **The service signature carries a deadline.** The brief's `attestBatch(root, count, schemaVersion, serviceSig)` gains a `uint64 deadline`, bounded to one hour ahead. A signed batch that leaks or sits in a stuck mempool cannot be submitted much later. Re-signing the same root with a new deadline is safe, because a root can be anchored only once.
- **What the contract cannot check.** It sees only the root, so it cannot enforce run-id uniqueness inside batches or check `count`. The service enforces run-id uniqueness in its database; `count` is the service's signed claim. On the direct path, the contract enforces run-id uniqueness itself (`DuplicateRun`).
- **The batch's block number is stored on chain.** A verifier reads `getBatch(id).blockNumber` and then fetches the `BatchAttested` event with a one-block `eth_getLogs`. That works on every Hemi RPC we tested, including dRPC's free plan, which refuses most ranges (D-6).

## D-3. Who signs

**Decision.** The agent, or its principal, signs the EIP-712 `Receipt` struct (`runId, manifestHash, agent, principal, schemaVersion`). The service countersigns a domain-separated envelope: `BatchAttestation(root, count, schemaVersion, deadline)` for batches, and `ServiceAttestation(receiptDigest, deadline)` over the agent's **full** digest for the direct path.

**What each signature proves.**

- The **agent signature** proves the agent, or the principal it acted for, owns the claim. It is checked on chain on the direct path. On the batch path it travels in the receipt file and is checked by `verify`, from the leaf fields alone.
- The **service signature** proves the service saw and batched the receipt. On chain, the registry only accepts a root countersigned by the current `serviceSigner`, and `BatchAttested` emits that signer's address. A batch's event therefore shows which service key vouched for it, even after the key rotates.
- **Domain separation.** The service signs a different struct type from the agent, so one signature can never pass both checks, even if the agent and the service are the same key. The contract tests check this case.

**Signature types.** The brief's open question asks whether agents sign with an EOA, a smart wallet or a key held by the principal. The registry accepts a signature from `agent` or `principal`. It checks both through one internal function, `_isValidAgentSignature`, which uses OpenZeppelin's `SignatureChecker`: ECDSA for EOAs and EIP-1271 for deployed contract wallets. The brief asked to keep 1271 addable later. `SignatureChecker` adds it now at no cost, because an internal function cannot be changed without a redeploy anyway. Counterfactual wallets (EIP-6492) verify off chain in the SDK through viem; on the direct path the wallet must be deployed first.

**Accounts.** The contract enforces that owner and service signer are different accounts: in the constructor, in `setServiceSigner` and in `transferOwnership`. `renounceOwnership` always reverts, because voiding and pausing are the incident response and need an owner.

## D-4. Status resolution

**Decision.** Each stage is read from data that anyone can check, never from a Hemi-run finality API, because none works today. An estimate never advances a receipt's stage. The full research, with every request, response and dead end, is in [research/STATUS_RESOLUTION.md](research/STATUS_RESOLUTION.md).

| Stage | Read as | Where it works |
|------|------|------|
| `hemi-included` | The anchoring tx's receipt exists and its block hash is still canonical | testnet and mainnet |
| `hemi-confirmed` | The anchoring block is at or below Hemi's `safe` head (its batch is posted to Ethereum and derived), has at least `HEMI_CONFIRMATIONS` blocks on top (default 10), and its hash is still canonical. A block that was reorged out goes back to `pending`. | testnet and mainnet |
| `btc-published` | Rebuild the keystone that covers the block, `K = ceil(B/25)·25`, from two Hemi RPC calls. Find a confirmed Bitcoin tx whose `OP_RETURN` is `6a4c50 "HEMI"` followed by the canonical 76-byte keystone, for `K` or any later keystone, which commits to all earlier blocks. The lowest Bitcoin height wins. | mainnet; **not reachable on testnet** |
| `btc-final` | Bitcoin confirmations of that publication, `tip − height + 1`, of at least 9 (Hemi's docs and bfgd v1). 11 or more is reported as super-final (bfgd v2). | mainnet; **not reachable on testnet** |

**Why not a Hemi API.** Every Hemi-operated source was checked live:

- **op-node `optimism_btcFinalityByBlockHash`** at `https://rpc.hemi.network/noderpc`. On mainnet it needs an undocumented second argument, the base URL of a BFG v2 instance, and no public BFG v2 instance exists. On testnet the method does not exist.
- **The explorer's `btc_finality` field** is always `-9` (not published) on testnet, even for two-year-old blocks. Hemi's Blockscout calls the op-node method above with one argument and maps the error to `-9`.
- **The BFG v1 websocket** `wss://pop.hemi.network/v1/ws/public` is live on mainnet. It serves only the latest keystones and the Bitcoin height, and it drops the connection on finality requests.
- **The testnet BFG** returns Cloudflare 526. Its old URL says: "PoP Mining on testnet is no longer incentivised".
- **`kss_*` RPC methods** are not exposed on the public RPC. **`safe` and `finalized`** are stock OP Stack and carry no Bitcoin meaning.

**Why the method is trustworthy.** The keystone rebuilt from public RPC matched Hemi's BFG data byte for byte. It matched the keystone hash in Hemi's op-node error string. It also matched the bytes in a real PoP tx:

```
$ python3 -I keystone.py https://rpc.hemi.network/rpc 5620225
"pop_opreturn_script_hex":"6a4c5048454d4901019152a20055c20104ddfaf81653745406b60e74126bbe37be01ec07b3019776d53d3594a18254de5647f184ff8941746bf20761dd1045552e1af1c0cb793360d1b3e5d6c873e1408ddef4"
# the same bytes are the OP_RETURN of Bitcoin tx d4ed6ec2eaa89b78906efc54c3dd309761bb30ca8a38b6477951033957a6845e in block 973746
$ cast call 0x0000000000000000000000000000000000000043 0xd4ed6ec2…845e --rpc-url https://rpc.hemi.network/rpc
0x00000005        # hVM's confirmation count; Esplora's tip gave the same 973750 − 973746 + 1
```

Rebuilding the full keystone matters: anyone can publish a "HEMI" `OP_RETURN`, so a candidate counts only if all 76 bytes equal the canonical keystone.

**Finding the PoP tx** needs Bitcoin data. The reader asks Esplora (blockstream.info, with mempool.space as fallback) for the transactions of known PoP-miner addresses. It also scans recent Bitcoin blocks for the `6a4c5048454d49` prefix, because the miner identity rotated three times in 60 days. Esplora is then a trusted source of Bitcoin data, and the hVM precompile `0x43` gives a cheap cross-check of the confirmation count.

**Testnet: why the Bitcoin stages cannot be read, and what is reported instead.** Nobody publishes Hemi testnet keystones to Bitcoin any more:

- No PoP tx appeared in 300+ recent testnet3 blocks or in the last 30 testnet4 blocks.
- Testnet keystone blocks from 4,000,000 to 7,100,500 contain no PoP payout tx. Block 3,000,000 did.
- The testnet BFG announces that testnet PoP mining is no longer incentivised.

The reader checks this live. It looks for a PoP payout tx (from `0x8888…8888`, selector `0x1725877d`) in keystone blocks over the last 6 hours, reading every 4th one, newest first, and stopping at the first payout. That is at most 18 Hemi RPC calls, cached for 5 minutes. If none appears, it reports `btc.source: "unavailable"` with the reason. On testnet `hemi-confirmed` is therefore the highest stage a receipt reaches, and the status says why.

The window was first the last 6 keystone blocks (30 minutes). A review showed that this calls mainnet dead while it is publishing: mainnet PoP runs in bursts with a backlog, and payouts pause for longer than 30 minutes. Measured on 2026-10-30:

```
43111  latest 5621363 | last 30 min: {"live":false,"reads":6} | 6 h every 4th: {"live":true,"payoutBlock":5620650,"reads":8}
743111 latest 7101022 | last 30 min: {"live":false,"reads":6} | 6 h every 4th: {"live":false,"reads":18}
```

**The estimate.** When PoP is live but a keystone is not yet found, the status carries "expected by" times. These are measured over a 70-hour mainnet window: 838 keystones, published after a median 15 minutes (90th percentile 2.5 hours), and final after a median 1.7 hours (90th percentile 4.2 hours). They are labelled `source: "estimate"` and never move the stage. Mainnet PoP is intermittent, with a payout on only 22 of 120 sampled days, so `btc-final` has no upper time bound and an estimate must not stand in for it.

**hemi-confirmed threshold.** Hemi blocks are exactly 12 s apart on both networks. The `safe` head trailed `latest` by at most 22 blocks in samples, so `safe` is a stronger and cheaper signal than a block count; the count is kept as a floor.

**For Hemi (a security note from the research).** The public mainnet op-node at `/noderpc` fetches whatever URL the caller passes as the second argument of `optimism_btcFinalityByBlockHash`. The research sent only `"0x1"`, which failed locally, and probed nothing internal. Hemi may want to know about this.

## D-5. Contract shape: where it departs from the brief's sketch

| Brief | Built | Why |
|------|------|------|
| `attestBatch(root, count, schemaVersion, serviceSig)` | adds `uint64 deadline` | A leaked or stuck signature expires within an hour (D-2) |
| `attest(receipt, agentSig, serviceSig)` | adds `uint64 deadline` | Same |
| `voidBatch(batchId)` | `voidBatch(batchId, expectedRoot, reason)` | A targeted void: an incident-time call fails loudly on a stale or mistyped target. The reason is emitted for the record. |
| `BatchAttested(batchId, root, count, schemaVersion)` | adds `serviceSigner` | So the event alone shows which key vouched for the batch (D-3) |
| `ReceiptAttested(runId, agent, principal, manifestHash)` | adds `batchId`, `schemaVersion` | Indexer completeness: events carry every stored field |
| `verifyInclusion(batchId, leaf, proof)` | kept, plus `verifyReceipt(batchId, receipt, proof)` | `verifyReceipt` derives the leaf and checks the schema version, so callers never handle raw leaves |
| — | `setSchemaVersionEnabled` | Schema v2 can be accepted without a redeploy |

The contract also uses `Ownable2Step`, `Pausable` (pause stops anchoring, never reads), a rotatable service key, replay rejection by id, and events that carry every field.

## D-6. RPC endpoints and log-range limits

**Decision.** Testnet uses only the public RPC by default; mainnet uses the public RPC first with dRPC as fallback. Every chain call goes through the SDK client, which retries transient errors with exponential backoff and paces requests at 4 per second, under the public RPC's roughly 300 per minute. Verification never scans log ranges.

```
$ cast chain-id --rpc-url https://rpc.hemi.network/rpc                 → 43111
$ cast chain-id --rpc-url https://testnet.rpc.hemi.network/rpc         → 743111
$ cast chain-id --rpc-url https://hemi.drpc.org                        → 43111
$ cast chain-id --rpc-url https://hemi-testnet.drpc.org                → 743111
$ cast block-number --rpc-url https://hemi-testnet.drpc.org            → 4443639
$ cast block-number --rpc-url https://testnet.rpc.hemi.network/rpc     → 7100459
$ cast block-number --rpc-url https://hemi.drpc.org                    → 5620802
$ cast block-number --rpc-url https://rpc.hemi.network/rpc             → 5620802
```

dRPC's testnet endpoint is about 2.66 million blocks behind. A status resolver reading it would report wrong confirmations and fail to find recent transactions, so it is excluded from the testnet defaults. The sibling facilitator project saw the same staleness (its D-015).

`eth_getLogs` against USDC.e, by span (the brief suggested paging in 2,000-block windows and preferring dRPC):

```
public testnet, span 2,000 / 10,000 / 50,000 / 100,000   → {"logs":3} each
public testnet, span 500,000                             → {"logs":15}
public testnet, span 1,000,000                           → {"logs":34}
dRPC testnet,   span 1,000 / 2,000 / 9,999 / 10,001       → {"error":{"message":"ranges over 10000 blocks are not supported on free plan","code":35}}
dRPC mainnet,   span 100                                 → {"logs":11}
dRPC mainnet,   span 2,000                               → {"error":{"message":"ranges over 10000 blocks are not supported on free plan","code":35}}
public mainnet, span 10,000                              → {"logs":6848}
```

**Infura/DIN** (`https://hemi-mainnet.infura.io/v3/KEY`, `https://hemi-testnet.infura.io/v3/KEY`) needs a project key, which this project does not have. Both hosts are up and refuse without one, so they are not in the defaults; a key can be added to `HEMI_RPC_URLS`:

```
$ curl -s -X POST https://hemi-mainnet.infura.io/v3/ -H 'content-type: application/json' --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' -w " HTTP %{http_code}"
invalid project id HTTP 401
$ curl -s -X POST https://hemi-testnet.infura.io/v3/ … (same request)
invalid project id HTTP 401
```

**CAIP-2 ids** are derived from the chain ids the RPCs report. They are the x402 network names used by the paywall (D-12), and the facilitator's `/supported` lists the same two:

```
$ echo eip155:$(cast chain-id --rpc-url https://rpc.hemi.network/rpc)          → eip155:43111
$ echo eip155:$(cast chain-id --rpc-url https://testnet.rpc.hemi.network/rpc)  → eip155:743111
```

dRPC's free plan refuses ranges far smaller than its error message says. Designing around that is cheap: the registry stores each batch's block number (D-2), so the only `eth_getLogs` the SDK and service make is a one-block query. If an indexer is added later, it should page in 2,000-block windows on the public RPC.

## D-7. Tokens, standards and Permit2 (for the x402 paywall)

Addresses come from Hemi's token list, which feeds the tunnel UI. They are cross-checked by on-chain reads and by each network's explorer: `testnet.explorer.hemi.xyz` at the time, and `explorer.hemi.xyz` for mainnet USDC.e on 2026-11-10. Aggregators were not used.

```
$ git ls-remote https://github.com/hemilabs/token-list HEAD
7a326ac4bf501e9205e0580625c9932fa8955f63	HEAD
$ curl -sS https://raw.githubusercontent.com/hemilabs/token-list/master/src/hemi.tokenlist.json | jq -c '.tokens[] | select(.symbol=="USDC.e" or .symbol=="hemiBTC" or .symbol=="hBTC") | {chainId, symbol, address}'
{"chainId":43111,"symbol":"hemiBTC","address":"0xAA40c0c7644e0b2B224509571e10ad20d9C4ef28"}
{"chainId":43111,"symbol":"USDC.e","address":"0xad11a8BEb98bbf61dbb1aa0F6d6F2ECD87b35afA"}
{"chainId":743111,"symbol":"hBTC","address":"0x36Ab5Dba83d5d470F670BC4c06d7Da685d9afAe7"}
{"chainId":743111,"symbol":"USDC.e","address":"0xD47971C7F5B1067d25cd45d30b2c9eb60de96443"}
```

The testnet explorer's token search (`/api/v2/tokens?q=USDC`) lists `0xD47971C7…6443` as the USDC.e with by far the most holders (206,837); the next "USDC" has 333.

The mainnet explorer's record for `0xad11a8BE…5afA` was added on 2026-11-10, shortly before 01:27 UTC. The build machine still could not reach that explorer, so the record was opened in a browser and its answer copied from there. The RPC read was run right after:

```
https://explorer.hemi.xyz/api/v2/tokens/0xad11a8BEb98bbf61dbb1aa0F6d6F2ECD87b35afA
{"address":"0xad11a8BEb98bbf61dbb1aa0F6d6F2ECD87b35afA","circulating_market_cap":null,"decimals":"6","exchange_rate":null,"holders":"5323","icon_url":null,"name":"Bridged USDC (Stargate)","symbol":"USDC.e","total_supply":"377166483341","type":"ERC-20","volume_24h":null}
$ cast call 0xad11a8BEb98bbf61dbb1aa0F6d6F2ECD87b35afA "totalSupply()(uint256)" --rpc-url https://rpc.hemi.network/rpc   → 377166483341   (block 5700610)
```

The explorer and the RPC give the same supply to the unit, so both describe the same contract, and the explorer counts 5,323 holders of it. About ninety minutes earlier the RPC had answered the mainnet reads below exactly as on 2026-10-29, `DOMAIN_SEPARATOR` included, and the token list (version 4.2.1) still held both mainnet addresses. The tunnel as served at `app.hemi.xyz` listed `0xad11a8BE…5afA` as its only token on chain 43111 with USDC in its name or symbol, and `0xAA40c0c7…ef28` as its only hemiBTC. Those entries were read from the token bundle the page loads (`/assets/queryOptions-….js`). The tunnel is built from the same token list, so it shows what Hemi ships and is not a separate source.

The remaining mainnet explorer reads were made at about 01:43 UTC on 2026-11-10 in a browser, with the RPC reads right after (block 5700696):

```
https://explorer.hemi.xyz/api/v2/tokens/0xAA40c0c7644e0b2B224509571e10ad20d9C4ef28
{"address":"0xAA40c0c7644e0b2B224509571e10ad20d9C4ef28","circulating_market_cap":null,"decimals":"8","exchange_rate":null,"holders":"6118","icon_url":null,"name":"Hemi Bitcoin","symbol":"hemiBTC","total_supply":"2711878868","type":"ERC-20","volume_24h":null}
$ cast call 0xAA40c0c7644e0b2B224509571e10ad20d9C4ef28 "totalSupply()(uint256)" --rpc-url https://rpc.hemi.network/rpc   → 2711878868
$ cast call 0xad11a8BEb98bbf61dbb1aa0F6d6F2ECD87b35afA "totalSupply()(uint256)" --rpc-url https://rpc.hemi.network/rpc   → 377166483341   (unchanged)
```

Both explorer records now match the RPC to the unit. The token searches turned up look-alikes, which matter only to anyone who picks a token by its symbol:

- `?q=USDC` lists `0xad11a8BE…5afA` first, with 5,323 holders; no other USDC-like token with 6 decimals has more than 109. One other token carries the exact symbol `USDC.e`: `0x614eB485DE3c6C49701b40806AC1B985ad6F0A2f`, named "USDC.e - wBTC, hemiBTC and ETH", with 6 decimals and 6 holders. The RPC returns the same name and symbol for it.
- `?q=USDC.e` lists that look-alike and leaves the real token out, so the explorer's symbol search cannot be used to find USDC.e.
- `?q=hemiBTC` lists `0xAA40c0c7…ef28` with 6,118 holders. One other token carries the exact symbol `hemiBTC`: `0xD172B64AA13d892bb5EB35f3482058eAE0BC5B2a`, "hemiBTC pool - bfBTC looping collateral", with 8 decimals and 1,230 holders. A principal token with "hemiBTC" in its name has more holders (10,615), under the symbol `PT-sw-bfBTC(hemiBTC)-2025/10/17`.

None of this reaches the service or the viewer. `service/src/config.ts` names USDC.e by address, and the payment checks its EIP-712 domain (name "Bridged USDC (Stargate)", version "2"). `viewer/src/present.ts` keys both labels by CAIP-19 address. Neither looks a token up by symbol.

```
$ cast call 0xad11a8BEb98bbf61dbb1aa0F6d6F2ECD87b35afA "name()(string)"   --rpc-url https://rpc.hemi.network/rpc   → "Bridged USDC (Stargate)"
$ cast call 0xad11a8BEb98bbf61dbb1aa0F6d6F2ECD87b35afA "symbol()(string)" --rpc-url https://rpc.hemi.network/rpc   → "USDC.e"
$ cast call 0xad11a8BEb98bbf61dbb1aa0F6d6F2ECD87b35afA "decimals()(uint8)" --rpc-url https://rpc.hemi.network/rpc  → 6
$ cast call 0xad11a8BEb98bbf61dbb1aa0F6d6F2ECD87b35afA "transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)" 0x0000000000000000000000000000000000000001 0x0000000000000000000000000000000000000001 1 0 99999999999 0x0000000000000000000000000000000000000000000000000000000000000000 27 0x0000000000000000000000000000000000000000000000000000000000000000 0x0000000000000000000000000000000000000000000000000000000000000000 --rpc-url https://rpc.hemi.network/rpc
Error: execution reverted: ECRecover: invalid signature          # the function exists and checked the signature: EIP-3009
$ cast call 0xad11a8BEb98bbf61dbb1aa0F6d6F2ECD87b35afA "authorizationState(address,bytes32)(bool)" 0x0000000000000000000000000000000000000001 0x0000000000000000000000000000000000000000000000000000000000000000 --rpc-url https://rpc.hemi.network/rpc   → false
$ cast call 0xad11a8BEb98bbf61dbb1aa0F6d6F2ECD87b35afA "DOMAIN_SEPARATOR()(bytes32)" --rpc-url https://rpc.hemi.network/rpc   → 0x6fe49ef2438be116233a7505f2b997466e49631ac8e197a2f1f208108d598a11
$ cast call 0xad11a8BEb98bbf61dbb1aa0F6d6F2ECD87b35afA "permit(address,address,uint256,uint256,uint8,bytes32,bytes32)" 0x0000000000000000000000000000000000000001 0x0000000000000000000000000000000000000001 1 99999999999 27 0x0000000000000000000000000000000000000000000000000000000000000000 0x0000000000000000000000000000000000000000000000000000000000000000 --rpc-url https://rpc.hemi.network/rpc
Error: execution reverted: ECRecover: invalid signature          # EIP-2612 permit exists

$ cast call 0xD47971C7F5B1067d25cd45d30b2c9eb60de96443 "symbol()(string)"  --rpc-url https://testnet.rpc.hemi.network/rpc   → "USDC.e"
$ cast call 0xD47971C7F5B1067d25cd45d30b2c9eb60de96443 "decimals()(uint8)" --rpc-url https://testnet.rpc.hemi.network/rpc   → 6
$ cast call 0xD47971C7F5B1067d25cd45d30b2c9eb60de96443 "transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)" 0x0000000000000000000000000000000000000001 0x0000000000000000000000000000000000000001 1 0 99999999999 0x0000000000000000000000000000000000000000000000000000000000000000 27 0x0000000000000000000000000000000000000000000000000000000000000000 0x0000000000000000000000000000000000000000000000000000000000000000 --rpc-url https://testnet.rpc.hemi.network/rpc
Error: server returned an error response: error code 3: execution reverted, data: "0x"   # no such function: no EIP-3009
$ cast call 0xD47971C7F5B1067d25cd45d30b2c9eb60de96443 "DOMAIN_SEPARATOR()(bytes32)" --rpc-url https://testnet.rpc.hemi.network/rpc
Error: server returned an error response: error code 3: execution reverted, data: "0x"   # no EIP-2612
$ curl -s https://testnet.explorer.hemi.xyz/api/v2/tokens/0xD47971C7F5B1067d25cd45d30b2c9eb60de96443 | jq -c '{name,symbol,decimals,type}'
{"name":"USDC.e","symbol":"USDC.e","decimals":"6","type":"ERC-20"}

$ cast call 0xAA40c0c7644e0b2B224509571e10ad20d9C4ef28 "name()(string)"   --rpc-url https://rpc.hemi.network/rpc   → "Hemi Bitcoin"
$ cast call 0xAA40c0c7644e0b2B224509571e10ad20d9C4ef28 "symbol()(string)" --rpc-url https://rpc.hemi.network/rpc   → "hemiBTC"
$ cast call 0xAA40c0c7644e0b2B224509571e10ad20d9C4ef28 "decimals()(uint8)" --rpc-url https://rpc.hemi.network/rpc  → 8
$ cast code 0xAA40c0c7644e0b2B224509571e10ad20d9C4ef28 --rpc-url https://testnet.rpc.hemi.network/rpc   → 0x   (no hemiBTC on testnet)
$ cast call 0x36Ab5Dba83d5d470F670BC4c06d7Da685d9afAe7 "name()(string)" --rpc-url https://testnet.rpc.hemi.network/rpc   → "HemiBitcoin"
$ cast call 0x36Ab5Dba83d5d470F670BC4c06d7Da685d9afAe7 "symbol()(string)" --rpc-url https://testnet.rpc.hemi.network/rpc   → "hBTC"
$ cast call 0x36Ab5Dba83d5d470F670BC4c06d7Da685d9afAe7 "decimals()(uint8)" --rpc-url https://testnet.rpc.hemi.network/rpc  → 8
$ curl -s https://testnet.explorer.hemi.xyz/api/v2/tokens/0x36Ab5Dba83d5d470F670BC4c06d7Da685d9afAe7 | jq -c '{name,symbol,decimals,type}'
{"name":"HemiBitcoin","symbol":"hBTC","decimals":"8","type":"ERC-20"}

$ cast code 0x000000000022D473030F116dDEE9F6B43aC78BA3 --rpc-url https://rpc.hemi.network/rpc | wc -c          → 18307 (9,152 bytes)
$ cast code 0x000000000022D473030F116dDEE9F6B43aC78BA3 --rpc-url https://testnet.rpc.hemi.network/rpc | wc -c  → 18307
```

The three Permit2 runtime hashes (Ethereum, Hemi mainnet, Hemi testnet) differ, because Permit2 bakes its chain ID and domain separator into immutables. The facilitator project checked that the Hemi deployments are genuine (its D-004) and deployed the testnet one.

**Consequence for this service.** The paywall (`POST /attest`) charges USDC.e through the x402 `exact` scheme: EIP-3009 on mainnet, Permit2 on testnet, where USDC.e has neither EIP-3009 nor EIP-2612. These match the facilitator's configuration. Prices: $0.001 per batched receipt and $0.01 for a direct attestation, in USDC.e base units (1,000 and 10,000).

## D-8. hBK

The hBK contract is not used by the MVP. The precompiles are: the Bitcoin finality reader can cross-check confirmations with `0x43` (D-4). Recorded here because the brief lists them.

```
$ cast code 0x7007dd1C09527B92AEcd8Ae6570B73d09E0B8F12 --rpc-url https://rpc.hemi.network/rpc | wc -c          → 16833
$ cast code 0xeC9fa5daC1118963933e1A675a4EEA0009b7f215 --rpc-url https://testnet.rpc.hemi.network/rpc | wc -c  → 20535
$ cast call 0x0000000000000000000000000000000000000044 0x --rpc-url https://testnet.rpc.hemi.network/rpc
0x004fb312…   # first 4 bytes: Bitcoin testnet3 height 0x4fb312 = 5,223,186
```

The addresses match docs.hemi.xyz ("Latest hBK release on Hemi / Hemi testnet"). That page is marked "outdated" by Hemi itself.

**ABI.** From Hemi's docs (`hemilabs/docs`, `hbk-smart-contract.md`), the `IBitcoinKit` interface is:

```
function getBitcoinAddressBalance(string calldata btcAddress) external view returns (uint256 balance)
function getUTXOsForBitcoinAddress(…)                        # listed in the docs
function getTransactionByTxId(bytes32 txId) external view returns (Transaction memory)
function getTransactionInputsByTxId(bytes32 txId) external view returns (Input[] memory)
function getTransactionOutputsByTxId(bytes32 txId) external view returns (Output[] memory)
function getTxConfirmations(bytes32 txId) external view returns (uint32 confirmations)
function getLastHeader() external view returns (BitcoinHeader memory)
function getHeaderN(uint32 height) external view returns (BitcoinHeader memory)
struct BitcoinHeader { uint32 height; bytes32 blockHash; uint32 version; bytes32 previousBlockHash; bytes32 merkleRoot; uint32 timestamp; uint32 bits; uint32 nonce; }
```

```
$ cast call 0x7007dd1C09527B92AEcd8Ae6570B73d09E0B8F12 'getLastHeader()((uint32,bytes32,uint32,bytes32,bytes32,uint32,uint32,uint32))' --rpc-url https://rpc.hemi.network/rpc
(973755, 0x00000000000000000000893d18d09349e933188a52b3a96cf5e7d8208123655e, 1073733632, …)
$ cast call 0xeC9fa5daC1118963933e1A675a4EEA0009b7f215 'getLastHeader()(…same tuple…)' --rpc-url https://testnet.rpc.hemi.network/rpc
Error: server returned an error response: error code 3: execution reverted, data: "0x"
```

The mainnet hBK decodes with the documented struct. The testnet hBK reverts, while the testnet precompile `0x44` answers. The facilitator project saw the same and left it open (its Q-2). The precompile `0x43` (`btcTxConfirmations`, input the 32-byte txid in display order, output a big-endian uint32) is documented with live outputs in research/STATUS_RESOLUTION.md §3.4. Precompiles `0x40`–`0x46` are from Hemi's hVM feature summary, as the facilitator project recorded in its D-012. Only `0x43` and `0x44` were called; `0x40`–`0x42`, `0x45` and `0x46` are listed from the docs and were not exercised, because the MVP does not use them.

## D-9. Testnet gas and accounts

Testnet gas is obtainable: Sepolia ETH tunneled through the Hemi portal, as the facilitator project documented (its README, "Funding"). The tunnel page is up; using it, and the faucets, needs a wallet and a captcha, which only a person can do:

```
$ curl -s -o /dev/null -w "%{http_code}\n" "https://app.hemi.xyz/en/tunnel/?networkType=testnet"
200
```

On 2026-10-29 that project's testnet wallets held funds, and gas is cheap:

```
$ cast balance 0x35C8182E886382D1133a3Daf980470D3646D3786 --ether --rpc-url https://testnet.rpc.hemi.network/rpc   → 0.019989828171471415
$ cast gas-price --rpc-url https://testnet.rpc.hemi.network/rpc                                                    → 1000253   (0.001 gwei)
```

At about 0.001 gwei, deploying the registry costs roughly 0.000002 ETH and one `attestBatch` about 0.0000002 ETH, so 0.002 testnet ETH covers the deployment and thousands of batches.

**Accounts.** Four fresh testnet keys were generated with `cast wallet new` into `.secrets/` (gitignored, mode 600). Only the relayer needs ETH.

| Role | Address | Holds ETH | Authority |
|------|------|------|------|
| Owner | `0xD572EfBA712C2284D1404eE47Be1599556B321e0` | only for admin calls | pause, void, rotate the service key, enable schema versions |
| Service signer | `0xdd801e02554E08f00F3F833CF08C9cb9B70FeA39` | no | countersigns batches and direct attestations |
| Relayer and deployer | `0xACadCDeE87cDbf94d440fe10E10371F8865AC22d` | yes, about 0.002 | none: it pays gas for the deployment and for `attestBatch` |
| Demo agent | `0x4C942E2C9ce38Ba8073E9D3fB5F4C2041E3A4E19` | no | signs the demo receipts |

The deployer passes the owner and service signer to the constructor, so the account that pays for the deployment holds no authority over the contract. The owner, the service signer and the account that pays gas are three separate keys.

**Funding.** The relayer was unfunded at first (`cast balance 0xACadCDeE87cDbf94d440fe10E10371F8865AC22d` → 0). Moving testnet ETH from the facilitator project's wallets would have needed that project's keys, which this build does not use, so the owner funded the relayer by hand:

```
$ cast balance 0xACadCDeE87cDbf94d440fe10E10371F8865AC22d --ether --rpc-url https://testnet.rpc.hemi.network/rpc
0.005000000000000000
$ curl -s "https://testnet.explorer.hemi.xyz/api/v2/addresses/0xACadCDeE87cDbf94d440fe10E10371F8865AC22d/transactions?filter=to" | jq -r '.items[] | [.hash, .from.hash, .value, .timestamp] | @tsv'
0x31d805f0050d954977ad5926d3cfa3a1c499dcd3adff4679480e6cf9b17fbbc0  0x1849FA6c53E143b170a6f400604883288213ADD3  5000000000000000  2026-10-29T23:50:48Z
```

Testnet gas was therefore obtainable within the session; it took a person, because faucets need a captcha. `scripts/testnet-deploy.sh --fork` rehearses the deployment on an anvil fork of Hemi testnet before the live run.

## D-10. Testnet deployment

**ReceiptRegistry on Hemi testnet: [`0xef9Bb805581c0E947DEA54052Ad360485c3F73Fe`](https://testnet.explorer.hemi.xyz/address/0xef9Bb805581c0E947DEA54052Ad360485c3F73Fe)**, source verified. Deployed 2026-10-29 by `scripts/testnet-deploy.sh` after a rehearsal on an anvil fork of testnet (`--fork`), which produced the same address and passed the same read-back.

```
deploy tx     0x4a4ccaf43738405a2f88c38ec309c6e3c7377204e56b7261bd5abc4a380ce09c
block         7100598
from          0xACadCDeE87cDbf94d440fe10E10371F8865AC22d   (relayer, nonce 0)
gasUsed       1977394
tip / max fee 1,000,000 wei / 1,000,507 wei   (effective gas price 1,000,253 wei; cost about 0.000002 ETH)

== read-back from chain ==
ok    registry-code = nonempty
ok    owner = 0xD572EfBA712C2284D1404eE47Be1599556B321e0
ok    serviceSigner = 0xdd801e02554E08f00F3F833CF08C9cb9B70FeA39
ok    schemaVersionEnabled(1) = true
ok    paused = false
ok    pendingOwner = 0x0000000000000000000000000000000000000000
ok    MAX_DEADLINE_WINDOW = 3600
ok    MAX_BATCH_COUNT = 65536
ok    batchCount = 0
ok    explorer is_verified = true
```

The owner (`0xD572…21e0`) and the service signer (`0xdd80…eA39`) are different accounts, and the contract would have refused them otherwise (D-3). The deployer holds no role.

**Source verification.** Hardhat's Blockscout verifier failed twice with `HHE80001 … https://testnet.explorer.hemi.xyz/api … Response status code 403: Forbidden`, once from `ignition deploy --verify` and once from `ignition verify`. Plain requests to the same `/api` path answered 200, so the explorer's edge rejects Hardhat's submission specifically; the cause was not investigated further. Blockscout's own v2 API accepted the exact solc standard-JSON input of the production build:

```
$ curl -X POST https://testnet.explorer.hemi.xyz/api/v2/smart-contracts/0xef9Bb805581c0E947DEA54052Ad360485c3F73Fe/verification/via/standard-input \
    -F compiler_version=v0.8.28+commit.7893614a -F contract_name=ReceiptRegistry -F license_type=mit \
    -F autodetect_constructor_args=false -F constructor_args=<abi-encoded owner, signer> -F 'files[0]=@standard-input.json'
{"message":"Smart-contract verification started"}
$ curl -s https://testnet.explorer.hemi.xyz/api/v2/smart-contracts/0xef9Bb805581c0E947DEA54052Ad360485c3F73Fe | jq -c '{is_verified, is_fully_verified, name, compiler_version, optimization_runs, evm_version}'
{"is_verified":true,"is_fully_verified":true,"name":"ReceiptRegistry","compiler_version":"v0.8.28+commit.7893614a","optimization_runs":200,"evm_version":"paris"}
```

`scripts/testnet-deploy.sh` now verifies this way. On mainnet, try `--verify` first and fall back to the same v2 call.

**Fees.** Ignition tipped exactly 1,000,000 wei, the node's suggestion, so the deployment was mined in the next block. The sibling facilitator project found that Hemi testnet never mines lower tips (its D-018), so the service's relayer tips at least this much too.

`DEPLOYMENTS[743111]` in `sdk/src/chains.ts` now names this registry, so `receipts verify` uses it by default on testnet.

## D-11. Live testnet run of the Definition of done

`scripts/testnet-demo.sh` ran on 2026-10-30 against the registry from D-10, with the service in Docker (`docker compose up -d receipts`). Docker's virtual disk on the build machine was full, so the service refused to start with "database or disk is full". The run therefore used `COMPOSE_FILE=docker-compose.yml:docker-compose.host-data.yml`, which keeps the SQLite file in `./data` on the host. Everything it printed and wrote is in [`demo/testnet-20261030T003831Z/`](../demo/testnet-20261030T003831Z/).

```
[demo] 3. receipts attest: three manifests → 202 created, then hemi-included
  0xaf6750aa6c9ff8f7fb46556223fc264543875faf9758e248e0abbd036d0e3dd8
  0x51f8b875fe2b416015449e42d840fedccd1bb997c3ff600d26f0fceb923bed74
  0xd1053cce11a6efe920105ec6a4b4160cbe961b4adb2fe1034bf910752080339a
[demo] 4. one BatchAttested tx contains all three
tx      0x595bdaf1d2f057260defaddd48f41c30b73075bd266719a0e34fa9095f895e1c
batch   1: (0x6566516d7819d1bee32d01d07bcfa3de698d0835c4c34cbb44c51b75bfa0d4c9, 3, 1, false, 0xdd801e02554E08f00F3F833CF08C9cb9B70FeA39, 1793320824, 7100834)
{"status":"0x1","blockNumber":"0x6c59a2","gasUsed":"0x252da","logs":1}
[demo] 5. receipts status
stage     hemi-confirmed
hemi      block 7100834 on Hemi Testnet, 10 confirmations (10 required), safe head 7100839, head 7100843
bitcoin   unavailable: no PoP activity: no PoP payout in the last 6 keystone blocks (blocks 7100700…7100825); …
[demo] 6. stop the service, then verify with only an RPC and the registry address
  pass  file / registry / chainId / manifest / agentSignature / anchor / merkleProof / batch / onchainProof / anchorTx / status
VALID: in batch 1, anchored by tx 0x595bdaf1…5e1c        (all three receipts)
```

The batch cost 152,282 gas (`0x252da`). Two tampered copies of a live receipt were then verified, also with the service stopped:

```
one changed manifest byte → INVALID: manifest hash mismatch: the file's manifest hashes to 0xc331e7d3…73cd, receipt says 0xf4c37682…f605   (exit 1)
forged agent signature    → INVALID: agent signature recovers to 0x3a0e5520…cd05, expected agent 0x4c942e2c…4e19 or principal 0x15d34aaf…6a65   (exit 1)
```

These two were run by hand for this first run. The proof-against-the-wrong-batch case needs a second batch; it is covered on a local chain by `e2e/test/dod.test.ts`, together with every other case above. After a review, `scripts/testnet-demo.sh` gained all three tamper cases (the wrong-batch one whenever an earlier batch exists) and asserts the `BatchAttested` count on chain. Later runs are listed in the README.

## D-12. x402 settlement through x402facilitator

**Decision.** `POST /attest` and `POST /attest/direct` sit behind x402 `exact` payments verified and settled by [x402facilitator](https://github.com/dimitryB/x402facilitator) (cloned next to this repository, at the image its compose file pins; the run below used `hemi-x402-facilitator:e75adda-hemi.8`). Requests are validated and replays answered before the paywall, so nobody pays for a rejected request or a resubmission. A request without payment gets a 402 built from configuration, even when the facilitator is down. Only a request that carries a payment needs the facilitator, and gets 503 `payment_unavailable` when it is unreachable.

**Ordering.** In `@x402/express` 2.29.0, the middleware verifies the payment, runs the route handler with the response held back, settles, and only then releases the response. The handler therefore stores a new receipt as `unpaid`, which is never batched. The settle hook promotes it to `queued`, so a failed settlement anchors nothing. A `settlement_pending` answer is recorded, so a retry is not charged twice while the payment tx is unmined.

**One receipt, one payment.** Two overlapping paid requests for one receipt could both pass the replay check, both reach the handler and both settle. A request that stores an `unpaid` row now holds a settlement lease on it (`settle_lease_until`, migration 0002), and a second request for that receipt gets `409 payment_pending` while the lease is held. The settle hooks end the lease as soon as the outcome is known. It runs its course only if something stops the request in between, nearly always a kill, so it is as long as a hold.

**An unknown outcome is held, not retried.** A failure that names a transaction goes to the poller, whatever its reason, because the chain can answer it: a payment that mined is accepted late, and a revert is released. Without a hash, only a facilitator that answers with a refusal proves that nothing moved. A timeout, a dropped connection or an HTTP error without a verdict can come after the transfer reached the chain, and so can `unexpected_settle_error` and `invalid_transaction_state`, which the facilitator's README lists for an ambiguous broadcast. The service records these as `settlement_unknown`, logs an error with the payer, nonce and amount, and holds the receipt for 30 minutes: retries get `409 payment_pending`. A mistaken hold costs the buyer a wait, and a mistaken release costs a second charge. The hold is stored in the lease column, so the handler's rewrite refuses a request that passed the precheck before the hold began.

**When a hold runs out, the chain decides.** A hold can only wait: against a fake facilitator, a retry after the 30 minutes was settled again although the first payment had landed. The payer's nonce is the one fact on chain that says whether an authorization was spent, and reading it needs no transaction hash. So before anyone pays again, the service reads `authorizationState(from, nonce)` on the token (EIP-3009) or bit `nonce & 0xff` of `nonceBitmap(from, nonce >> 8)` on Permit2. The next request does this for `settlement_unknown`, and the poller for a named transaction it gives up on, which also catches a transaction replaced under another hash. A used nonce is not yet an answer (next paragraph): the logs then decide whether the payment landed. A failed read proves nothing, so the hold stays and the log says so. An unused nonce decides only once the authorization has expired, because until then a transaction still in a mempool can land after the read. The SDK's buyers sign `maxTimeoutSeconds`, 300 by default, so only a longer deadline stays held. Reads go to `HEMI_RPC_URLS` in order, and testnet's stale dRPC is deliberately not among them (D-6); a lagging node would have to be over 25 minutes behind to report a landed payment as unused. The write that releases a row compares `payment_json` with the record the read started from, so a slow answer cannot end the lease of a retry that owns the row by now. A row with no authorization on record is from before settling wrote one. It has no nonce to read, so it is released as before, with an error in the log.

**What a used nonce does not prove.** It shows that an authorization was consumed, not that money moved. A payer can consume its own nonce with `invalidateUnorderedNonces` on Permit2 or `cancelAuthorization` on EIP-3009, and that reads the same. Run on forks of testnet Permit2 and mainnet USDC.e on 2026-11-02, the service's read returned `true` after each cancel, and `false` for a neighbouring nonce in the same word. The facilitator answers a settle of a spent nonce with `invalid_transaction_state` and no transaction (its `tests/e2e/02-settle.test.ts`). The service cannot treat that as a refusal, because the same answer can follow a payment that mined. So a buyer who got a cancel mined between the service's verify and settle reached a hold, and had the receipt free when it ended, for the gas of the cancel; such records said `via: "nonce"`.

**So a used nonce is placed by the logs.** Settling now also records the chain's head (`settleBlock`, read with a 2 s limit, best effort) and the time it began. When a hold ends on a used nonce, the service searches the asset's and Permit2's logs from that head (less 100 blocks) to the block where the authorization's deadline falls (plus 100), in 5,000-block pieces; both Hemi RPCs served 20,000-block ranges on 2026-11-09. Hemi gives every block a later second than its parent, so a span of N seconds holds at most N blocks, and without a recorded head the search starts that many blocks back from the time settling began. Three outcomes:

- *The buyer's cancel*: `AuthorizationCanceled(payer, nonce)` on the token, or `UnorderedNonceInvalidation(payer, word, mask)` on Permit2 with this nonce's bit. Both contracts emit one on every cancel. Nothing was paid: the row becomes `settlement_abandoned` with `cancelTx`, and a retry pays. A cancel decides even next to a transfer, because Permit2 lets a nonce be invalidated after it paid, and an honest buyer never cancels.
- *A transfer that settled this authorization*: `Transfer(payer, PAY_TO, amount)` on the asset, in a transaction whose call decodes to the settlement of exactly this authorization: `transferWithAuthorization` sent to the token, or the x402 Permit2 proxy's `settle` / `settleWithPermit` sent to the proxy, with token, payer, recipient, amount and nonce all matching (D-16). Settled, `via: "transfer"`, with `transferTx`. A transfer to `PAY_TO` that settled another nonce pays for something else and does not count. (Before D-16 the input only had to contain the nonce's 32 bytes; the nonce is the buyer's choice, so those bytes could be an amount.)
- *Neither*: the hold stays, and an error names the payer, nonce and blocks. The likely cause is an RPC that returned too few logs, and the next read decides. A spend made by a call this service does not decode (a wrapper such as a multicall) stays held for good; RUNBOOK §6 says what to do.

Releasing on "neither" was rejected: an RPC missing logs would then charge an honest buyer twice. Accepting on "neither" was rejected too: it is the gap this closes, for any RPC that drops the cancel. The stub that stands in for Permit2 and the token in `service/test/x402.test.ts` emits the real events in real transactions, and the seven tests for these cases fail when a used nonce is again taken as paid.

**Stopping during a settlement.** The facilitator finishes a settlement even if the service hangs up. On SIGTERM or SIGINT the service therefore stops taking connections at once and waits up to 185 seconds for what is in flight, which fits the two 90-second settle attempts the x402 client makes. It counts each paid request from its arrival to its response, settlement included, so a request that was still verifying when the stop began, and whose buyer then hangs up, is waited for too. Counting settlements alone missed that case (a review showed an exit 314 ms after SIGTERM with the settlement still running). A paid request that arrives after the stop began, on a connection kept alive, gets `503 service_stopping` before verify, so nothing of it is settled. Further signals join the same stop rather than killing it; until 1c0e8b9 a second SIGTERM did kill it. Signal handlers are installed before startup, which exits at once on a signal since nothing has been served, and compose runs a small init as PID 1 because node as PID 1 ignores a signal it has no handler for. Compose allows 190 seconds. A kill gives it no such chance, so the next start records every row with a lease and no outcome as `settlement_unknown`, however long the outage was, logs its run id and holds it for 30 minutes. The payer and nonce survive a kill, because settling starts by writing them to the row (status `settling`). If that write fails the settlement is refused: nothing has moved yet, and settling without a record could cost a second charge. A kill still loses the hash of a settlement that was pending, but the chain decides without it.

**Evidence: a real settlement, on local forks.** `scripts/x402-fork-demo.sh` forks Hemi testnet and mainnet with the facilitator project's own `scripts/fork.sh`, then starts its facilitator image against the forks. It runs this service with `DEV_FREE` unset. The CLI then pays the 402 with `X402_PRIVATE_KEY`: USDC.e through Permit2, with a one-time approval. Only anvil's public dev keys are used, and nothing touches a live network. Output from the 2026-10-30 run ([`demo/x402-fork-20261030T010042Z/run.log`](../demo/x402-fork-20261030T010042Z/run.log)):

```
[{"scheme":"exact","network":"eip155:43111"},{"scheme":"exact","network":"eip155:743111"}]      # facilitator /supported
{"ok":true,"chainId":743111,"registry":"0x5FbDB2315678afecb367f032d93F642f64180aa3","devFree":false}
paying 1000 base units of 0xD47971C7F5B1067d25cd45d30b2c9eb60de96443 on eip155:743111 to 0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc from 0x90F79bf6EB2c4f870365E785982E1f101E93b906 (x402 permit2)
approve(Permit2, max) sent: 0x761d8c33ae287042b8cb9d11bfca906b106d647dc68252c81ee711d261a73951
0x745830507509066cf8df454295b4760051a21dd66e18096121e7f42e88bf305d hemi-included
payTo USDC.e base units: 0 -> 1000 (price 1000)
INFO  x402: payment settled runId=0x7458…305d tx=0x17e6f5c79c1a7fa04a0693e468a6569135a8ca9bf4002a899c42c72a3989ab70 payer=0x90F7…b906 amount=1000 promoted=true
{"runId":"0x7458…305d","anchor":{"batchId":1,"txHash":"0xc33376a7b373a7c87664318ca8ee2c0bbcbf95bcb1a7db9f4b92059d0e679cd4"}}
```

It ran again on 2026-11-13, exactly as written, against facilitator image `hemi-x402-facilitator:e75adda-hemi.19`, with the same outcome: [`demo/x402-fork-20261113T011857Z/run.log`](../demo/x402-fork-20261113T011857Z/run.log).

**Why a fork and not live testnet.** A live settlement needs a buyer holding testnet USDC.e and ETH. This project's demo agent holds neither, and funding it means moving test funds between wallets, which is left to a person. The facilitator is the same image and configuration that settled live on testnet for its own project (its `docs/testnet-run.md`). To repeat this live: fund a buyer with testnet USDC.e (the facilitator project's D-017 has the routes), run the facilitator with its testnet config, start this service with `DEV_FREE` unset, and run `X402_PRIVATE_KEY=… receipts attest m.json --approve-permit2`.

**One fix the demo forced.** viem's `waitForTransactionReceipt` waits for a block after the transaction before it looks. On an anvil fork that mines only on demand, no such block comes and the wait never ends. The SDK now has `pollTransactionReceipt`, and the CLI's Permit2 approval and the deploy helpers use it.

## D-13. Receipt viewer

**Decision.** One static page (`viewer/`), with no framework and no backend. esbuild bundles the SDK and viem into one ES module of about 390 KB. The page runs the SDK's own `verify()` in the browser, so the reviewer sees exactly what `receipts verify` would say. A plain-language layer (`viewer/src/present.ts`, unit-tested) puts it into words. The design uses one saturated hue (Hemi orange), warm neutrals, and danger shown as orange pushed hotter rather than a second hue. Every verdict also carries a glyph and words, so nothing depends on colour.

**Why it can verify in a browser.** Every endpoint it needs allows cross-origin requests:

```
$ curl -s -i -X POST -H "Origin: http://localhost:5173" -H 'content-type: application/json' --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' https://testnet.rpc.hemi.network/rpc | grep -i access-control-allow-origin
access-control-allow-origin: *
(the same for https://rpc.hemi.network/rpc and https://hemi.drpc.org)
$ curl -s -i -H "Origin: http://localhost:5173" https://blockstream.info/api/blocks/tip/height | grep -i access-control-allow-origin
Access-Control-Allow-Origin: *
(the same for https://blockstream.info/testnet/api and https://mempool.space/api)
```

**Choices.**
- **Trust root.** The registry comes from the SDK's `DEPLOYMENTS`, never from the file, as in the CLI. For an unknown chain the page asks the reviewer instead of guessing.
- **No service in the verdict.** A receipt loaded with `?service=` is fetched from the service and then verified against the chain like any other. To allow that, the service now sends `Access-Control-Allow-Origin: *` on its read-only routes (`/receipts`, `/batches`, `/health`). Those serve public data; the paid POST routes stay same-origin. `service/test/attest-idempotency.test.ts` checks both.
- **Progress only for a receipt that checks out.** A forged or tampered receipt shows no finality ladder: progress would suggest the claim is merely early. A receipt file with no anchor reads "This copy does not say where it was recorded", in the waiting tone, not as a failure. A receipt fetched before its batch is recorded comes that way, but so does a copy with its anchor removed, so the page says what the file lacks rather than what Hemi holds.
- **Bitcoin scanning is opt-in on mainnet.** The default looks only at known PoP-miner addresses, which takes a few small requests. Scanning raw Bitcoin blocks (about 1.6 MB each, up to 36) needs the reviewer to tick a box.
- **Untrusted input.** Receipt content is placed with `textContent` only.

**Checked in a browser** (against live Hemi testnet): all five examples (genuine; private; one changed byte; forged signature; wrong batch) gave the expected verdict and reasons. The paste path and `?service=` against the running service worked. Light and dark themes render, and at 375 px wide there is no horizontal scroll, with the verdict first.

**When the page cannot reach the network.** The viewer can also be shared as a single page on claude.ai (`npm run build:artifact -w viewer` builds it into `viewer/dist/artifact/`). That frame blocks every request to another site, the Hemi RPC included. So the page sends one `eth_chainId` request first. If nothing answers at all, it runs `verify()` against a client that fails at once, which leaves only the checks that need no network: the file, the registry, the record of the run, the anchor, the local Merkle proof, and an ordinary-key signature. The page says it could not reach Hemi. A definite failure still rejects the receipt (a changed byte is a changed byte anywhere). Anything else reads "Not checked against Hemi", with no finality ladder. A signature that does not recover to the agent stays unconfirmed, not forged, because a contract-wallet signature needs the chain.

For the bundled examples only, the page then shows the full result recorded against testnet by `npm run record -w viewer` (`viewer/samples/recorded.json`), with a notice giving the date. It shows that result only when the example's checks that need no network, re-run on the spot, agree with it (`agreesLocally` in `viewer/src/present.ts`). A test re-runs those checks for every example and confirms that each one matches its own recorded result and no other. A receipt the reviewer brings is never matched to a recorded result. Opened on a computer with network access, the page checks everything live, as before. It opens on the genuine example rather than an empty page, and `#<example>` selects another one.

## D-14. Mainnet deployment

**ReceiptRegistry on Hemi mainnet: [`0x95127A8aCa9B5c235C56A2dfd315a567Ef545A40`](https://explorer.hemi.xyz/address/0x95127A8aCa9B5c235C56A2dfd315a567Ef545A40)**. Deployed on 2026-11-13 at 02:03 UTC, on the owner's explicit go, with `CONFIRM_MAINNET_DEPLOY=yes npm run deploy:hemi -w contracts` (RUNBOOK §5). The deployer key was entered at Hardhat's keystore prompts, never on a command line.

```
deploy tx      0xa03cba69f0b7beae8c0547182de386c90ba779248d013893fcecba8000aab3ff
block          5722390   (2026-11-13T02:03:11Z)
from           0x1155c33c3ef5d0dee61c98d21f2e22c053a60875   (x402facilitator's deployer and mainnet signer, nonce 6)
gasUsed        1977394   (the same as on testnet)
cost           about 0.0000074 ETH, L1 data fee included (the deployer's balance change)
owner          0xbe191f7072aD49c4c15434780C5cE0ED5bfB7535   Safe 1.5.0 L2 (singleton 0xEdd160fEBBD92E350D4D398fb636302fccd67C7e), 1 of 1,
                                                            signer 0xDf95Efa5095c8160b9f3E90367ED0858FFF3b7d4, no modules, no guard
serviceSigner  0xcFD277613FcB5d6A7B2BFcA93d44E78a1d3c6E0c   plain key, no code
relayer        0x0c9aCd4F85946587fC15CA55Ea9A1c48Aaee162f   pays batch gas, no role in the contract

== read-back from chain, right after the deploy ==
owner                    0xbe191f7072aD49c4c15434780C5cE0ED5bfB7535
serviceSigner            0xcFD277613FcB5d6A7B2BFcA93d44E78a1d3c6E0c
schemaVersionEnabled(1)  true
paused                   false
MAX_DEADLINE_WINDOW      3600
MAX_BATCH_COUNT          65536
pendingOwner             0x0000000000000000000000000000000000000000
runtime code             8462 bytes, equal to the build Ignition deployed once its 7 immutables are blanked
```

Choices made for this deploy:

- **The deployer is x402facilitator's.** The registry gives its deployer no role: owner and signer are constructor arguments, and the contract never reads `msg.sender` for them. The same key is that facilitator's live settlement signer, so the deploy ran while the facilitator was not running, to keep that wallet's nonce free.
- **The relayer, service signer and smoke-test buyer have fresh keys**, kept apart from the testnet ones, in `.secrets/mainnet-{relayer,service,agent}.json` (gitignored). The buyer is `0xaA3B6FF39AcB56D96dbE1F8458eF907D4FeE383F`.
- **The owner is a 1-of-1 Safe.** It passes RUNBOOK §5's rule that the owner has code, and lets a leaked signer be replaced without touching the registry. A second signer can be added later with the Safe's own `addOwnerWithThreshold`.
- **Source verification** failed at the deploy's `--verify` step, because the build machine could not reach `explorer.hemi.xyz` (the note at the top). Nothing had to be submitted: when the [contract page](https://explorer.hemi.xyz/address/0x95127A8aCa9B5c235C56A2dfd315a567Ef545A40?tab=contract) was opened in a browser later that night, it read "Contract Source Code Verified (Exact Match)", matched by the Blockscout Bytecode Database. That service matches new contracts against source already verified on any Blockscout instance; the testnet registry carries the same compiler input and was verified on 2026-10-29 (D-10). A Standard JSON input for a manual submission had been prepared from Ignition's build-info and was not needed.

Funding before the deploy, read on chain at 01:37 UTC: the deployer 0.002193 ETH, the relayer 0.002 ETH, the buyer 0.05 USDC.e (the `0xad11a8BE…5afA` token), the Safe's signer 0.001 ETH.

**Smoke test (RUNBOOK §7), 2026-11-13 02:23–02:29 UTC, on the owner's go: passed.** With x402facilitator running and serving its mainnet signer, the owner ran `CONFIRM_MAINNET_SMOKE=yes scripts/mainnet-smoke.sh`. Evidence is in [`demo/mainnet-smoke-20261113T022336Z`](../demo/mainnet-smoke-20261113T022336Z/). The service ran from `service/dist` with `DEV_FREE` unset.

```
payments (x402 exact, EIP-3009; facilitator signer 0x1155c33c…0875 sent each transferWithAuthorization)
  0x6effe1b1cfb1c294e3f6747b6f5aa1e043ae38a11de4ee8da3a69705ddcd9716  block 5722493  105,320 gas  Transfer buyer → Safe 0.001 USDC.e, AuthorizationUsed
  0x41d25df9c1c4193d250f2acf29baa84e0c7d806145094af0c2632553a2055d0a  block 5722494   88,196 gas  Transfer buyer → Safe 0.001 USDC.e, AuthorizationUsed
  0x3309a47af2ec6d6b31876da648983ce9ea9bb5cbc40b30e397745590ec171d9c  block 5722495   88,220 gas  Transfer buyer → Safe 0.001 USDC.e, AuthorizationUsed
anchor
  0x06396351b82b2fce9f685163897b55aacbd020133e735e30f2f7a8947fda134b  block 5722499  152,270 gas  from the relayer
  BatchAttested batchId 1, count 3; getBatch(1): count 3, schemaVersion 1, not voided, signer 0xcFD2…6E0c
balances after  buyer 0.047 USDC.e (−0.003), Safe 0.003 USDC.e (+0.003)
fees            0.0000014 ETH for the four transactions, L1 data fees included
verify          all three VALID with the service stopped (hemi-confirmed, 18–19 confirmations), with --registry
                and again with the SDK's known deployment; Bitcoin publication estimated, not yet observed
```

**Bitcoin finality.** The receipts' covering keystone is 5722500. PoP publication paused from about 02:31 UTC on 2026-11-13, while Bitcoin fees stayed well above what the PoP miner pays (about 0.14 sat/vB), and the reader reported "no PoP activity" meanwhile. Publication resumed on 2026-11-14: keystone 5734725, a descendant, went into Bitcoin block 975836 (tx `c6835b0e6675122e8ccf103d361af4ef1c7d4883d46e48c1be91a858e66c6a23`), and the receipts read `btc-final` from its 9th confirmation. The viewer's mainnet example was re-recorded at that stage.

No private key appears in the run's files or in the files changed for the deploy: they were compared, in-process, against every key in `.secrets/`.

## D-15. Fixes from an outside review

An outside review on 2026-11-15 reported seven findings. Each was checked against the code; all seven held, and each now has a test.

| # | Finding | Fix |
|---|------|------|
| 1 | One x402 authorization could pay for two receipts: offered for a second run id while the first was settling, the second settle failed with `invalid_transaction_state` (read as "may have moved"), and when its hold ran out the nonce's transfer was credited to it too | `payment_claims` (migration 0004): the first run id to settle an authorization owns it; any other run id is refused before the facilitator is asked (`payment_reused`), and both recoveries (the nonce, a named tx) credit only the owner. Rows already on record were backfilled, oldest first |
| 2 | `scripts/testnet-deploy.sh` backed `.env` up as `.env.bak.<epoch>`, which was not gitignored and was left world-readable | `.gitignore` covers `.env.*` except `.env.example`; the backup is written owner-only |
| 3 | `receipts attest --direct` named its file from the service's runId (`../` escaped `--out`) | The file is named from the local manifest, and the answer is refused unless its receipt, target (the registry), chain, calldata (`attest` for this receipt and signature) and deadline all match |
| 4 | btc-final batches were never read again, so a later void never reached the API | They are re-read with `getBatch` alone every `POLL_FINAL_CHECK_SECONDS` (3600); migration 0003 schedules those already final |
| 5 | `receipts status` checked only the block height the service reported | `resolveAnchorStatus` (SDK) reads the batch from a registry the user trusts (`--registry`, default the known deployment), its `BatchAttested` log and transaction, then the stage pinned to that block's hash |
| 6 | The Docker healthcheck passed while the RPC was down (`/health` answers 200 with `ok:false`) | The healthcheck reads `ok`. `/health` still answers 200, since Docker and Compose never restart a container for being unhealthy, and an orchestrator that does should probe liveness by status code |
| 7 | `GET /%` crashed `viewer/serve.mjs` (`URIError` outside the try) | A malformed URL is a 400. A directory without `index.html` crashed it the same way (headers sent before the read); it is now a 404 |

## D-16. Fixes from a second outside review

A second review on 2026-11-15 reported five findings, two of them against D-15's payment fix. Each was reproduced or checked against the code, all five held, and each fix has a test that fails without it.

| # | Finding | Fix |
|---|------|------|
| 1 | A payment claim was keyed by the nonce as sent. Permit2 reads it as a number, so `"0" + nonce` was the same authorization under a new claim, and one transfer could again pay for two receipts | Claims are keyed by the canonical nonce (`canonicalNonce`: Permit2 decimal without leading zeros, EIP-3009 exactly 32 bytes), with payer and token as checked addresses; a nonce no contract would accept is refused (`invalid_payment_authorization`). The authorization is read from the payload field of the configured transfer method, and a payload carrying both fields is refused. Migration 0005 rewrites existing claims, the earliest keeping a merged key |
| 2 | Recovery tied a transfer to an authorization when the transaction's input merely contained the nonce's 32 bytes; a buyer-chosen nonce of 1000 matched an unrelated settlement of amount 1000 | `settledAuthorization` decodes the call (`transferWithAuthorization` sent to the token; the x402 Permit2 proxy's `settle` / `settleWithPermit` sent to the proxy) and requires token, payer, recipient, amount and nonce to match. Any other call leaves the hold undecided |
| 3 | A keystone abrev more than an hour old was cached for good; after a Hemi reorg the old fork's publication still counted as Bitcoin evidence | A cached keystone is re-checked against the block's current hash on every read until the chain reports it `finalized` (Hemi networks only); a changed hash drops the entry |
| 4 | `scripts/testnet-deploy.sh` always used Ignition id `receipts-hemi-testnet`, whose journal is committed, so anyone else's keys failed reconciliation (and overwrote the committed parameters file) | The committed id and parameters are used only with the committed owner and signer; other keys get `receipts-hemi-testnet-<owner's first 8 hex digits>` (or `DEPLOYMENT_ID`) and their own parameters file, both gitignored. Checked with fresh keys against a local anvil: Ignition deploys and every read-back passes |
| 5 | After a signer rotation and a restart with the new key, stored signatures (pending batches, direct attestations) were reused until they expired, and the registry refused them | Before a batch is sent, and when a direct attestation is resubmitted, the stored signature's signer is recovered; one made by another key is re-signed. A batch the registry still refuses logs that the service key is not the registry's signer |

The test stand-in for Permit2, the token and the proxy (`service/test/fixtures/SettleStub.sol`) now receives the facilitator's real settlement calldata, so the tests exercise the decoding.

## Open questions

Findings this build reports back rather than resolving alone.

- **Q-1. Mainnet token addresses on the explorer.** Answered on 2026-11-10. The explorer's records for USDC.e `0xad11a8BE…5afA` and hemiBTC `0xAA40c0c7…ef28` match the token list and the RPC, down to the total supply. Each is the token of that symbol with by far the most holders. Each symbol also has a look-alike, `0x614eB485…0A2f` and `0xD172B64A…5B2a`. The code names tokens only by address, so a look-alike cannot stand in for either (D-7). The reads were made in a browser (see the note at the top).
- **Q-2. A supported finality API.** Ask Hemi whether a public bfgd v2 URL exists, whether `optimism_btcFinalityByBlockHash` will be fixed (it breaks their own explorer), whether testnet PoP will return, and whether they call 9 or 11 Bitcoin confirmations "final" (D-4).
- **Q-3. Mainnet.** Mainnet changes need the owner's explicit go. The registry was deployed on such a go on 2026-11-13 (D-14). The smoke test passed on another go the same night (D-14). Its source is verified on `explorer.hemi.xyz` (D-14), so nothing about the mainnet launch is open.
