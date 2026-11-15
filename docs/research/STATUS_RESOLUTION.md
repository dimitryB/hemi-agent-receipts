# Status resolution: how far has a Hemi tx travelled toward Bitcoin?

Research date: 2026-10-29 (UTC 23:00 to 00:10). Everything marked VERIFIED was observed live from the build
machine with the command shown. Times are unix seconds unless noted. The scripts used are in
[`status_resolution_scripts/`](status_resolution_scripts/). They are research probes, not production code.
They use only the Python stdlib and Node 22+ built-ins.

Stages: `pending` → `hemi-included` → `hemi-confirmed` → `btc-published` → `btc-final`.

---

## 1. Summary

**Main finding:** Hemi runs no public, working API that answers "is block B Bitcoin-final?". Every
Hemi-operated candidate is missing, private, or broken (§6). You can still resolve both Bitcoin stages
**trust-minimised from public data**:

1. Rebuild the keystone that covers the block from ordinary Hemi JSON-RPC.
2. Find the Bitcoin PoP tx that carries it, using a public Esplora API (blockstream.info / mempool.space).
3. Count Bitcoin confirmations.

This works on **mainnet**, checked end to end against Hemi's own BFG data and hVM.

**Testnet has had no PoP activity** for at least many months. The two Bitcoin stages can never be
reached there today.

| Stage | Recommended read method | Status | Cost per status refresh |
|---|---|---|---|
| `pending` / `hemi-included` | `eth_getTransactionReceipt(tx)`: null means pending, non-null means included (`status` 0x1/0x0). Optional reorg check: `eth_getBlockByNumber(receipt.blockNumber).hash == receipt.blockHash`. | VERIFIED on testnet and mainnet | 1 Hemi RPC call (+1 for the reorg check) |
| `hemi-confirmed` | `receipt.blockNumber <= eth_getBlockByNumber("safe").number`. This is the OP-stack safe head: the L2 batch is posted to Ethereum and has been derived. If you need a fixed count instead, use N = 30 (see §5). | VERIFIED on testnet and mainnet | 1 Hemi RPC call per poll, shared by all txs |
| `btc-published` | Covering keystone `K = ceil(B/25)*25`. Build its canonical 76-byte abbreviated keystone from 2 Hemi RPC calls (§3.2). Look for a Bitcoin tx whose `OP_RETURN` is `6a4c50` + `"HEMI"` + abrev, for `K` **or any later keystone** (a later keystone anchors its ancestors). The effective publication height is the lowest such Bitcoin height. Find PoP txs either by polling known PoP-miner addresses on Esplora (cheap) or by scanning each new Bitcoin block (robust, needed to discover new miners) (§3.3). | VERIFIED on mainnet. Testnet: UNAVAILABLE (no PoP txs in 300+ recent testnet3 blocks or 30 testnet4 blocks; no PoP payouts in testnet blocks sampled since block 4,000,000) | 2 Hemi RPC calls once per keystone (cache them) + 1 Esplora call per poll (address mode), or 2 Esplora calls per new BTC block (~1.6 MB each) in indexer mode |
| `btc-final` | `confirmations = btcTip − pubHeight + 1 ≥ 9`. Get the tip from Esplora `/blocks/tip/height`, or call the hVM precompile directly: `eth_call` to `0x…43` with the PoP txid returns the confirmation count (§3.4). | VERIFIED on mainnet (the hVM `0x43` result matched the Esplora count, 5 and then 6). The `0x43` call also works on testnet for any testnet3 tx. | 1 call (Esplora or Hemi RPC) |

Hemi-operated finality sources checked (details in §6). None is usable today:

- **op-node `optimism_btcFinalityByBlockHash`** at `https://rpc.hemi.network/noderpc`.
  - Mainnet: needs an undocumented 2nd parameter, which it uses as the base URL of a BFG v2.
  - Testnet (`/noderpc`): the method does not exist.
- **Explorer `btc_finality`**: always `-9` on testnet, including blocks that are 2 years old. The cause is
  that Hemi's Blockscout calls the op-node method with 1 parameter (traced in its source). Mainnet
  explorer: could not check (blocked by the ISP).
- **BFG v1 public websocket** `wss://pop.hemi.network/v1/ws/public`: live on mainnet.
  - Serves only the latest keystones and the BTC height.
  - Finality commands close the socket.
  - Testnet BFG returns Cloudflare 526 or "moved".
- **BFG v2 HTTP** `GET /v2/keystonefinality/{hash}`: no public instance found.
- **op-geth `kss_*`** namespace: not exposed on the public HTTP or WS RPC.

Key measured numbers:

- **Hemi block time:** exactly **12.0 s** on both networks.
- **Keystone period:** every 25 blocks, so every 300 s.
- **Mainnet, ~70 h window with PoP active, 838 keystone slots:**
  - Effective `btc-published` delay after the keystone block: p50 15 min, p90 2.5 h, max 6.0 h.
  - Effective `btc-final` (9 confirmations) delay: p50 1.7 h, p90 4.2 h, p99 7.1 h, max 7.8 h.
  - 15% of keystones were never published themselves and inherit from a later keystone.
- **Mainnet PoP is intermittent.** Only **22 of 120** daily samples over the last 120 days had a PoP
  payout. Long gaps with no PoP at all are normal, so `btc-final` has **no upper time bound**.

---

## 2. Background (verified formats)

### 2.1 Keystones

A keystone is produced at every L2 block `K` where `K % 25 == 0`:

- `hemi.KeystoneHeaderPeriod = 25` in `heminetwork/hemi/hemi.go`, commented "every 5m".
- The op-node rule for the keystone that gives block `B` finality is
  `K = B if B%25==0 else B + 25 − B%25`. Source: `getKeystoneProvidingFinality` in
  `hemilabs/optimism` `op-node/node/bvm_api_helper.go` @086fd45e2.

Full keystone fields:

| Field | Source |
|---|---|
| `version` | always 1 |
| `l1_block_number` | the L1 origin of block K |
| `l2_block_number` | K |
| `parent_ep_hash` | `block(K).parentHash` |
| `prev_ep_keystone_hash` | `block(K−25).hash` |
| `state_root` | `block(K).stateRoot` |
| `ep_hash` | `block(K).hash` |

Source: `L2Keystone` in `heminetwork/hemi/hemi.go`, built in `op-node/rollup/sequencing/sequencer.go`.

**L1 origin number from public RPC.** The first tx of every Hemi block is the OP-stack L1-info deposit
to `0x4200…0015`, with selector `0x098999be`, packed in the Isthmus layout of 176 bytes. Bytes `[28:36]`
are the big-endian L1 block number.

Example from mainnet block 5620225, input
`0x098999be|000f4240|00000000|0000000000000000|000000006ae3ba8f|00000000019152a2|…`, gives L1 block
`0x019152a2 = 26301090`.

**Abbreviated keystone (76 bytes).** Source: `heminetwork/hemi/hemi.go` `L2KeystoneAbrev.Serialize`.

| Bytes | Content |
|---|---|
| `[0]` | version |
| `[1:5]` | l1 (big-endian u32) |
| `[5:9]` | l2 (big-endian u32) |
| `[9:20]` | the first **11** bytes of parentHash |
| `[20:32]` | the first 12 bytes of the previous keystone's hash |
| `[32:64]` | stateRoot |
| `[64:76]` | the first 12 bytes of the block hash |

The **keystone hash** is `doubleSHA256(abrev)`, displayed **byte-reversed** (Bitcoin `chainhash`
display order). That is the form bfgd v2 and the op-node use in URLs.

**PoP transaction.** Source: `heminetwork/hemi/pop/pop.go`. A Bitcoin tx with an output script of
`OP_RETURN OP_PUSHDATA1 0x50 "HEMI" <76-byte abrev>`, which in hex is `6a 4c 50 48454d49 <abrev>`
(83 bytes in total). The first input is P2PKH. Its pubkey is the miner identity:

- The Hemi payout address is `keccak256(uncompressed pubkey)[12:]`.
- The Bitcoin address is the P2PKH of the same key.

**Verification of the derivation.** Script: [`keystone.py`](status_resolution_scripts/keystone.py).

```text
$ python3 -I keystone.py https://rpc.hemi.network/rpc 5620800 | jq -c .keystone
{"version":1,"l1_block_number":26301664,"l2_block_number":5620800,"parent_ep_hash":"7ee804a8…fc54","prev_ep_keystone_hash":"b6f0bc3d…af92","state_root":"3b8d06b2…1d8e","ep_hash":"24171666…064a"}
# identical, byte for byte, to the keystone returned by Hemi's BFG (bfgapi-l2-keystones-response, §6.3)

$ python3 -I keystone.py https://rpc.hemi.network/rpc 5619323 | jq -c '{keystone_block,abrev_hash}'
{"keystone_block":5619325,"abrev_hash":"20134dc964abd6c5ac5e671abe857aa7e6fef5e32eecf7b36e79d6ff7bfd0ff0"}
# identical to the hash Hemi's mainnet op-node computed for the same block (it is in its error string, §6.1)
```

The PoP tx `d4ed6ec2…845e` in BTC block 973746 carries
`6a4c50 48454d49 01 019152a2 0055c201 04ddfaf81653745406b60e 74126bbe37be01ec07b30197 76d53d35…cb7933 60d1b3e5d6c873e1408ddef4`.
That is version 1, L1 26301090, L2 5620225, then the parentHash[:11] of block 5620225, the hash[:12] of
block 5620200, the stateRoot, and the hash[:12] of block 5620225. All of these were checked against
`eth_getBlockByNumber` (§3.2).

### 2.2 Descendant inheritance

Publishing keystone `K'` commits to the hash of block `K'`, and therefore to every earlier block. bfgd v2
(`service/bfg/bfg.go` `handleKeystoneFinality`) reports the queried keystone's finality as the
**maximum effective confirmations over the keystone and its descendants**. It fetches 10 descendants at a
time from op-geth and stops at 20 confirmations or when no descendants remain.

This matters on mainnet. In the 70 h window, 128 of 838 keystones were never published themselves:

```text
missing runs (first,last,count): [(5603975, 5605550, 64), (5611525, 5612400, 36), (5612775, 5612950, 8),
                                  (5615800, 5615875, 4), (5618050, 5618175, 6), (5619575, 5619800, 10)]
keystone 5619575 -> payout txs in block 5620075: 0     # confirms never published (see 3.6)
keystone 5619825 -> payout txs in block 5620325: 1
```

Out-of-order publication (a descendant landing in an *earlier* BTC block than its ancestor) was never
observed: 0 cases. So "the first published keystone ≥ K" gives the same result as "the minimum height
over descendants". Use the minimum anyway to be safe.

### 2.3 "Final" thresholds differ between sources. Recommendation: confirmations ≥ 9

| Source | Rule |
|---|---|
| Hemi docs | "Hemi blocks achieve finality typically nine blocks … after their proofs are published". The same page also says "After six Bitcoin blocks … superfinality". |
| bfgd **v1** / op-node v1 / Blockscout `btc_finality` | `btc_finality = (tip − pubHeight + 1) − 9`, capped at 100. `-9` means not published. `≥ 0` means final, i.e. **≥ 9 confirmations** counting the publication block. Source: `hemi.L2BTCFinalityFromBfgd` @v1.6.3. |
| bfgd **v2** | `effective_confirmations = tip − pubHeight` (0 when in the tip block). `super_finality = effective_confirmations >= 10` (`bfgapi.BitcoinSuperFinality = 10`), which is 11 confirmations counting the publication block. |

**Recommendation:** store the raw `confirmations = tip − pubHeight + 1`. Define `btc-final` as `≥ 9`, which
matches the docs, v1 and the project spec. Optionally show `≥ 11` as "super-final (bfgd v2)".

---

## 3. Recommended algorithm, with exact request and response shapes

Endpoints:

- **Hemi RPC.** Testnet: `https://testnet.rpc.hemi.network/rpc` (fallback `https://hemi-testnet.drpc.org`).
  Mainnet: `https://rpc.hemi.network/rpc` (fallback `https://hemi.drpc.org`). `rpc_modules` on the
  public RPC lists `eth, net, rpc, txpool, web3` only. dRPC does not support `rpc_modules`.
- **Esplora.** Mainnet: `https://blockstream.info/api` or `https://mempool.space/api`. Testnet3 (the
  network Hemi testnet's hVM follows): `https://blockstream.info/testnet/api`.
- **Rate limits.** mempool.space returned **HTTP 429** after about 60 quick requests (about 25 of them raw
  blocks). blockstream.info was fine at about 1.5 req/s. Back off on 429 and timeouts.

### 3.1 Hemi RPC: inclusion and confirmation

```text
POST {"jsonrpc":"2.0","id":1,"method":"eth_getTransactionReceipt","params":["<txhash>"]}
testnet → {"blockNumber":"0x6c5895","blockHash":"0x3d7e93d6…88af","transactionHash":"0x0861ed46…9e99","status":"0x1","transactionIndex":"0x1"}
mainnet → {"blockNumber":"0x55c1f1","blockHash":"0x9bcc361b…95ab","transactionHash":"0x545eefb3…bcc","status":"0x1","transactionIndex":"0x1"}
(result is null while the tx is pending or unknown)

POST {"jsonrpc":"2.0","id":1,"method":"eth_getBlockByNumber","params":["safe",false]}   # also "latest", "finalized"
testnet 2026-10-29T23:44Z: latest 0x6c5827 (ts 0x6ae3d5b4)  safe 0x6c5823  finalized 0x6c57dd
mainnet 2026-10-29T23:44Z: latest 0x55c43d (ts 0x6ae3d5b3)  safe 0x55c42e  finalized 0x55c3d2
```

### 3.2 Keystone derivation: 2 calls per keystone, results immutable once final

```text
eth_getBlockByNumber(hex(K), true)     → parentHash, stateRoot, hash, transactions[0].input (L1-info)
eth_getBlockByNumber(hex(K-25), false) → hash
```

Real example (mainnet, `keystone.py https://rpc.hemi.network/rpc 5620225`):

```json
{"keystone_block":5620225,"keystone_timestamp":1793309411,
 "keystone":{"version":1,"l1_block_number":26301090,"l2_block_number":5620225,
  "parent_ep_hash":"04ddfaf81653745406b60e99f8b9236b5a1c2657080f8d7e980bc7388dda51ab",
  "prev_ep_keystone_hash":"74126bbe37be01ec07b30197863b8872ca24cd23239d4f7a53c0c8f41f3cc9e4",
  "state_root":"76d53d3594a18254de5647f184ff8941746bf20761dd1045552e1af1c0cb7933",
  "ep_hash":"60d1b3e5d6c873e1408ddef4f2b6736366484b781f704d45c501f883e85cc4d4"},
 "pop_opreturn_script_hex":"6a4c5048454d4901019152a20055c20104ddfaf81653745406b60e74126bbe37be01ec07b3019776d53d3594a18254de5647f184ff8941746bf20761dd1045552e1af1c0cb793360d1b3e5d6c873e1408ddef4",
 "abrev_hash":"6eaf6d4c73a5bca25c2721cb0a4f914c2bfa2b034e544576ccfa9c9a18273cbe"}
```

Testnet example (`keystone.py https://testnet.rpc.hemi.network/rpc 7099500`): keystone 7099500, ts
1793304816, abrev_hash `7be19b906da98bba80833c1a78db736c31d9b3cbe067172c954645b058117099`. No PoP tx for
it exists on testnet3 (§3.5).

Reference implementation (Python, the core of `status_probe.py`):

```python
def abrev_of(rpc_url, k):
    kb = rpc(rpc_url, "eth_getBlockByNumber", [hex(k), True])
    pb = rpc(rpc_url, "eth_getBlockByNumber", [hex(k - 25), False])
    info = bytes.fromhex(kb["transactions"][0]["input"][2:])   # L1-info deposit, Isthmus packed
    l1 = int.from_bytes(info[28:36], "big")
    return (bytes([1]) + l1.to_bytes(4, "big") + k.to_bytes(4, "big")
            + bytes.fromhex(kb["parentHash"][2:])[:11] + bytes.fromhex(pb["hash"][2:])[:12]
            + bytes.fromhex(kb["stateRoot"][2:]) + bytes.fromhex(kb["hash"][2:])[:12])
# keystone hash (display order) = sha256(sha256(abrev)).digest()[::-1].hex()
```

Always compare the full 76-byte abrev in a Bitcoin `OP_RETURN` with the canonical abrev. Anyone can
publish a "HEMI" OP_RETURN, including for a non-canonical fork.

### 3.3 Finding the PoP transaction on Bitcoin

**Mode A: poll PoP-miner addresses.** This is cheap. One call returns the address's mempool txs
(blockstream.info: up to 50) plus its newest confirmed txs (25 on blockstream.info; mempool.space returned 30
in our run). A miner that is keeping up publishes one tx per keystone, so this covers
about the last 2 h. Page further back with `/address/{a}/txs/chain/{last_seen_txid}`.

```text
GET https://blockstream.info/api/address/17Fv7httdZvqMubbvMkQ9KLPiTSPobxAqF/txs
→ [ {"txid":"d4ed6ec2eaa89b78906efc54c3dd309761bb30ca8a38b6477951033957a6845e",
     "status":{"confirmed":true,"block_height":973746,"block_hash":"00000000000000000000c9ba…f4c2","block_time":1793309506},
     "vin":[{"txid":"8a6e3304…52ea","vout":0,"scriptsig_asm":"OP_PUSHBYTES_72 3045…","prevout":{"scriptpubkey_address":"17Fv7httdZvqMubbvMkQ9KLPiTSPobxAqF"}}],
     "vout":[{"scriptpubkey":"76a91444a2eab624146b6f8185a6af19645460e9f5f9a488ac","scriptpubkey_type":"p2pkh","value":17680},
             {"scriptpubkey":"6a4c5048454d4901019152a20055c201…60d1b3e5d6c873e1408ddef4","scriptpubkey_type":"op_return","value":0}]},
   … ]   # unconfirmed txs have "status":{"confirmed":false}
```

The `l2_block_number` is decoded directly from the OP_RETURN (`script[12:16]` as big-endian u32, i.e.
abrev bytes `[5:9]`). In the sample, the 20 mempool txs carried keystones 5620250…5620725 and the
confirmed txs carried 5620225 and earlier.

Miner identities **rotate**:

| When | Payout recipient |
|---|---|
| Last 6 days | `0x9595d445…d5a7` (BTC `17Fv7httdZvqMubbvMkQ9KLPiTSPobxAqF`; the EVM address was re-derived from the BTC pubkey and matches) |
| 7–10 days ago | `0xb39E152F…9b25` |
| About 60 days ago | `0xda54120B…d8f4` |

So mode A needs discovery:

- When a new recipient appears in the payout txs of recent keystone blocks (§3.6), run mode B over the
  recent Bitcoin blocks to learn its Bitcoin address.
- Or run mode B continuously.

**Mode B: Bitcoin block indexer.** This is robust and needs no miner list.

1. For each new BTC block, call `GET /block-height/{h}` (returns the hash as text).
2. Then call `GET /block/{hash}/raw` (binary, 1.5–1.75 MB on mainnet).
3. Search the bytes for `6a4c5048454d49`. Parse the matching tx for its txid and record
   `abrev → (btc_height, txid)`.

That costs 288 calls and about 240 MB per day on mainnet. Script: [`find_pop.py`](status_resolution_scripts/find_pop.py).

```text
$ python3 -I find_pop.py https://mempool.space/api <pop_payload_hex of keystone 5620225> 1793309411 25
{"btc_tip": 973750, "scan_from": 973730}
… {"height": 973745, "time": 1793309335, "size": 1651687, "pop_txids": []}
{"height": 973746, "hash": "00000000000000000000c9ba432b1076e9e670b53042330b57042123b6a1f4c2", "time": 1793309506, "size": 1623442,
 "pop_txids": ["d4ed6ec2eaa89b78906efc54c3dd309761bb30ca8a38b6477951033957a6845e"]}
… {"found": [[973746, ["d4ed6ec2…845e"]]], "btc_tip": 973750}

# all PoP txs in three blocks (one miner, consecutive keystones, batches of chained txs):
973734: 14 PoP txs, keystones 5619225…5619550
973739:  9 PoP txs, keystones 5619825…5620025
973744:  5 PoP txs, keystones 5620075…5620175
```

A self-hosted `tbcd` from `heminetwork` would serve the same lookup without scanning. It needs a full
Bitcoin node. The commands are `tbcapi-l2-keystone-txs-by-abrev-hash-request` and
`tbcapi-keystones-by-height-request` on `ws://localhost:8082/v1/ws`. No public tbcd was found.

### 3.4 Confirmations: Esplora tip, or hVM precompile `0x43`

```text
GET https://blockstream.info/api/blocks/tip/height   → 973750        (mempool.space returned the same)

# hVM precompile 0x43 = btcTxConfirmations(txid): input is the 32-byte txid in display (Esplora) order.
# Output is a big-endian uint32: confirmations against op-geth's embedded Bitcoin node tip.
POST rpc.hemi.network/rpc {"method":"eth_call","params":[{"to":"0x0000000000000000000000000000000000000043","data":"0xd4ed6ec2eaa89b78906efc54c3dd309761bb30ca8a38b6477951033957a6845e"},"latest"]}
→ {"result":"0x00000005"}        # = 973750 − 973746 + 1
# after BTC block 973751 arrived, the same call through https://hemi.drpc.org → {"result":"0x00000006"}
# testnet: a testnet3 coinbase txid 20 blocks deep → {"result":"0x00000015"} (21, as expected)
# unknown txid → {"error":{"code":-32000,"message":"tx not found: 1111…"}}

# hVM precompile 0x44 = btcLastHeader (no input). Output: height u32 | blockHash(32, display order) |
# version u32 | prevHash(32) | merkleRoot(32) | time u32 | bits u32 | nonce u32
POST … {"to":"0x0000000000000000000000000000000000000044","data":"0x"} →
mainnet: "0x000edbb4 00000000000000000000932ba69480989ca33bbbeae4fdb166f96e0851bcdb24 24e12000 …"
         # height 973748, 2 blocks behind the Esplora tip at the same moment
testnet: height 5223186 (blockstream testnet3 tip was 5223188)
```

`0x43` counts against the embedded node's upstream tip and matched Esplora exactly both times.
`0x44` reports the hVM UTXO-indexed height, which lagged by 2 blocks. That makes it a conservative tip for
counting confirmations.

### 3.5 End-to-end runs (VERIFIED)

Script: [`status_probe.py`](status_resolution_scripts/status_probe.py). Usage:
`status_probe.py <hemi-rpc> <esplora> <txhash> [miner-btc-address…]`.

```text
# mainnet, block 5620209 → keystone 5620225 published directly
{"block":5620209,"latest":5620941,"safe":5620923,"stage":"btc-published","covering_keystone":5620225,
 "btc":{"published":true,"via_keystone":5620225,"inherited":false,"pop_txid":"d4ed6ec2…845e","pub_height":973746,
        "btc_tip":973750,"confirmations":5,"btc_finality_v1":-4},"calls":{"hemi_rpc":6,"esplora":2}}

# mainnet, block 5619605 → keystone 5619625 never published → inherits from keystone 5619825
{"block":5619605,"stage":"btc-final","covering_keystone":5619625,
 "btc":{"published":true,"via_keystone":5619825,"inherited":true,"pop_txid":"ebecd1a5…07a5","pub_height":973739,
        "btc_tip":973750,"confirmations":12,"btc_finality_v1":3},"calls":{"hemi_rpc":6,"esplora":2}}

# mainnet, a fresh tx (block 5620908): safe, keystone 5620925 not yet on Bitcoin
{"block":5620908,"safe":5620923,"stage":"hemi-confirmed","covering_keystone":5620925,"btc":{"published":false,"in_btc_mempool":[]}}

# testnet (blocks 7100565 and 7099487): stage "hemi-confirmed"; no PoP exists on testnet
{"block":7099487,"latest":7100603,"safe":7100602,"stage":"hemi-confirmed","covering_keystone":7099500,"btc":{"published":false,…}}
```

Testnet PoP evidence:

- `find_pop.py` over the 40 testnet3 blocks starting at the keystone's time − 2 h found nothing.
- `find_pop_sparse.py` over testnet3 5222983…5223188, the 94 blocks with more than 1 tx, found nothing
  for keystone 7099500.
- No `HEMI` OP_RETURN of any kind appeared in testnet3 5223089…5223188 or in the last 30 testnet4 blocks.
- Testnet keystone blocks 4,000,000 … 7,100,500 (11 samples) contained **no** PoP payout tx. Block
  3,000,000 did.
- The old testnet BFG URL now says
  `"Testnet BFG endpoint has moved … PoP Mining on testnet is no longer incentivised"`.

### 3.6 Hemi-RPC-only liveness signal: PoP payout txs

At every keystone block `N`, the sequencer pays the PoP miners of keystone `N − 500`. The delay is
`derive.PoPPayoutDelay = 500` in `op-node/rollup/derive/pop_payout.go`. The payout tx has these
properties:

- type `0x7d`
- from `0x8888888888888888888888888888888888888888`
- to `0x455f8f0b8df5399873700f60aa931d6b89ac9c79` on mainnet
- selector `0x1725877d`, which is `mintPoPRewards(uint64 blockRewarded, address[] miners, uint256[] amounts)`

One entry is paid per PoP tx found by op-geth's embedded node (`KeystoneTxsByL2KeystoneAbrevHash`,
depth 3).

```text
$ cast calldata-decode 'mintPoPRewards(uint64,address[],uint32[])' <input of the 0x8888… tx in block 5620725>
5620225
[0x9595d445F12B4eF7862c0Ff1EaB18F0cc50ad5a7]
[1000000000000000000]
```

A payout at `K+500` proves keystone `K` reached Bitcoin within about 100 min. It does not give the BTC
height. Use it for two things:

- A cheap "is PoP alive right now?" check before showing any estimate.
- A trigger for miner discovery.

The 120-day daily sample (one keystone per day, 120 RPC calls) gave `days sampled 120 with payout 22`,
from newest to oldest:
`.#######.###.#.#.##..................................#....####............#..................................#......#...`.
On a sampled day with no payout (keystone 5404900, 2026-09-29), we scanned the 12 BTC blocks after it
(969228…969239) for the bare `6a4c5048454d49` prefix. They contained **no PoP tx for any keystone**. That is
consistent with PoP being completely off on that day, not just late.

---

## 4. Measured mainnet cadence, and the ESTIMATE fallback

**Method.** The script was `cadence.py https://blockstream.info/api 17Fv7httdZvqMubbvMkQ9KLPiTSPobxAqF 72 5620225 1793309411`:

- It paged the miner's history (29 Esplora pages) and took the first BTC block containing each keystone.
- Keystone time is `ts(5620225) + (K − 5620225)·12`. The 12 s rule was checked: block 5599300 has ts
  `0x6adfe607` = 1793058311, as predicted.
- "Final" is the time of BTC block `pubHeight + 8`.

**Results** (keystones 5599300…5620225, about 69.8 h, 226 BTC blocks with publications):

```text
published keystones 710, missing 128 (inherit from the next published keystone), 20 more sitting unconfirmed in the BTC mempool
per published keystone:   pub delay p50 11.3 min, p90 48.8, p99 215.6, max 250.6 | final p50 92.1 min, p90 149.9, max 332.2
EFFECTIVE (all 838 slots, with inheritance, measured from the keystone block's timestamp):
  btc-published delay (min): p50 15.0  p75 42.9  p90 149.2  p95 220.6  p99 319.2  max 359.2
  btc-final (9 conf) delay (min): p50 102.0  p75 142.6  p90 252.5  p95 322.5  p99 427.5  max 467.5
```

The miner sends chains of txs. As many as 14 PoP txs were seen confirming in one BTC block (973734). At the time of
measurement it had 20 unconfirmed txs queued.

**Estimate formula.** Label it as an ESTIMATE and use it only when the indexer is unavailable:

```
t_K = t_B + (K − B)·12 s               # K = ceil(B/25)*25; t_B = block timestamp
gate: PoP is "live" only if a payout tx (§3.6) appears in at least one of the last 6 keystone blocks
if not live: btc stages are "unknown, no recent PoP activity". Never estimate a time.
if live:
  P(btc-published by t_K + 15 min) ≈ 0.50, +43 min ≈ 0.75, +149 min ≈ 0.90, +221 min ≈ 0.95, +319 min ≈ 0.99
  P(btc-final     by t_K + 102 min) ≈ 0.50, +143 min ≈ 0.75, +253 min ≈ 0.90, +323 min ≈ 0.95, +428 min ≈ 0.99
```

Uncertainty:

- The sample is one 70 h window with a single active miner.
- The distribution depends on BTC fee and mempool conditions and on the miner's tx-chain behaviour.
- PoP stopped completely for weeks at a time during the last 120 days.
- **Never mark `btc-final` from an estimate.** If you show anything, show "expected by …".

---

## 5. Hemi block time and the `hemi-confirmed` threshold

| Network | Block time | Measurement |
|---|---|---|
| Testnet | 12.0 s | Blocks 7099500 → 7100455: 955 blocks in 11460 s |
| Mainnet | 12.0 s | Blocks 5599300 → 5620797: 21497 blocks in 257964 s |

Blockscout testnet `/api/v2/stats` also reports `average_block_time: 1.2e4` ms.

Safe and finalized lag, sampled every 20 s over 2 min, measured in blocks behind `latest`:

```text
testnet  safe_lag 4,6,8,10,1,3      finalized_lag 74,76,78,80,81,83   (≈15–17 min)
mainnet  safe_lag 18,20,22,1,3,4    finalized_lag 136,138,140,94,96,97 (≈19–28 min)
earlier single samples: testnet safe 4 / fin 74; mainnet safe 15 / fin 107
```

`safe` follows a sawtooth pattern: it jumps forward each time a batch is posted to Ethereum. `finalized`
follows Ethereum finality. The Hemi op-node finality code is stock OP-stack (`finalityDelay = 64`, no
Bitcoin references in `op-node/rollup/finality/`), so **`finalized` has no Bitcoin meaning**.

**Recommendation.** Define `hemi-confirmed` as `blockNumber ≤ safe`. This costs 1 call per poll and
applies to every tracked tx.

- If a fixed count is required, use **N = 30 blocks (6 min)**. The largest safe lag observed was 22.
- Reorgs were not measured. In theory, unsafe blocks can only reorg if the single sequencer's output is
  not what derivation from Ethereum produces. Safe blocks can only reorg if Ethereum reorgs. Finalized
  blocks are irreversible.
- Always re-check `receipt.blockHash` against the canonical block at that height (1 call) before
  advancing stages.

---

## 6. Hemi-operated endpoints evaluated: dead ends and partial results

### 6.1 op-node `optimism_btcFinalityByBlockHash`. Found but not usable

The `hemi-viem` package (`src/actions/public/get-btc-finality-by-block-hash.ts` @81d7256) calls
`optimism_btcFinalityByBlockHash([blockHash])` on the chain's `opNode` RPC URLs:
`https://rpc.hemi.network/noderpc` and `https://testnet.rpc.hemi.network/noderpc`. The endpoints are live
(`optimism_syncStatus` and `optimism_version` → `"untagged-"` answer), but:

```text
testnet /noderpc optimism_btcFinalityByBlockHash ["0xa4cb5e0c…67b3"] → {"code":-32601,"message":"the method optimism_btcFinalityByBlockHash does not exist/is not available"}
mainnet /noderpc optimism_btcFinalityByBlockHash ["0x5721c38f…8b6a"] → {"code":-32602,"message":"missing value for required argument 1"}
mainnet  … ["0x5721…8b6a", true] → "invalid argument 1: json: cannot unmarshal bool into Go value of type string"
mainnet  … ["0x5721…8b6a", "0x1"] → {"code":-32000,"message":"Get \"0x1/v2/keystonefinality/20134dc964abd6c5ac5e671abe857aa7e6fef5e32eecf7b36e79d6ff7bfd0ff0\": unsupported protocol scheme \"\""}
mainnet optimism_btcFinalityByRecentKeystones ["0x2"] → {"code":-32000,"message":"not yet"}
```

The deployed mainnet op-node therefore takes the **BFG v2 base URL as a caller-supplied 2nd parameter**.
It then fetches `<url>/v2/keystonefinality/<abrev hash>` and returns bfgd v2's
`L2KeystoneBitcoinFinalityResponse`. That response shape is
`{l2_keystone, block_hash, block_height, effective_confirmations, super_finality}`.

- In source at `hemilabs/optimism@086fd45e2`, the URL is node config (`n.bfgURL`). The current `hemi`
  HEAD (`f04d7b3`) no longer has these methods. The deployed binary is untagged.
- No public BFG v2 URL is known, so the method is unusable.
- **Security note for Hemi.** The public op-node makes outbound HTTP requests to a URL the caller
  chooses. We only sent `"0x1"`, which failed locally. We did not probe any internal addresses. Consider
  reporting this to Hemi.

### 6.2 Explorer `btc_finality`. Present but always −9

`GET https://testnet.explorer.hemi.xyz/api/v2/blocks/<n>` and `/api/v2/transactions/<hash>` include
`btc_finality`. The backend version is `v6.9.0-hemi.25`. Samples:

- 14 blocks aged 0 to 4 days: all `-9`.
- 10 blocks from 2024-11 to 2026-10: all `-9`.
- tx `0xe4ee8ec3…8c94`: `-9`.

Cause, found in `hemilabs/blockscout@production-hemi` (2a3df83),
`apps/ethereum_jsonrpc/lib/ethereum_jsonrpc/op_node.ex`. It calls `optimism_btcFinalityByBlockHash` with
`params: [block_hash]` and maps any error to `-9`. With the op-node behaviour in §6.1, this can only ever
return `-9`.

The mainnet explorer (`explorer.hemi.xyz`) could not be reached: TLS errors from curl and from WebFetch.
It is probably also `-9` for the same reason, but that is unverified.

### 6.3 BFG v1 public websocket `wss://pop.hemi.network/v1/ws/public`. Live on mainnet, no finality

This is the URL Hemi's PoP-miner docs give (`docs.hemi.xyz/llms-full.txt`, `POPM_BFG_URL`).
- **Protocol.** Source: `heminetwork@v1.6.3` `api/protocol`, `api/auth/secp256k1.go`, `api/bfgapi`.
  - Every frame is a JSON text message: `{"header":{"command":"<cmd>","id":"<id>"},"payload":{…}}`.
  - Handshake:
    1. Client sends `secp256k1-hello` with `{publickey: <33-byte compressed hex>, userAgent}`.
    2. Server replies `secp256k1-hello-challenge` with `{message: hex(16-byte nonce || "Hello: <pub>\nMessage: I am not a robot!\n")}`.
    3. Client replies `secp256k1-hello-challenge-accepted` with `{signature: hex(65-byte compact sig over sha256(message bytes))}`.
       The header byte is `27 + recid + 4`, then `r || s`, with low-S.
    4. Server sends `bfgapi-ping-request`.
  - **Do not answer that ping.** The public read loop treats `bfgapi-ping-response` as an unknown command
    and closes the socket.
- **Public commands:** `bfgapi-ping-request`, `bfgapi-l2-keystones-request {num_l2_keystones}`,
  `bfgapi-bitcoin-info-request`, `bfgapi-bitcoin-balance-request`, `bfgapi-bitcoin-utxos-request`,
  `bfgapi-bitcoin-broadcast-request`.
- **Finality commands are private only:** `bfgapi-btc-finality-by-recent-keystones-request`,
  `bfgapi-btc-finality-by-keystones-request`, `bfgapi-pop-txs-for-l2-block-request`.
- Minimal client, run as-is: [`bfg-v1-probe.mjs`](status_resolution_scripts/bfg-v1-probe.mjs) (Node 26
  built-in WebSocket, dependency-free secp256k1). Its output:

```text
$ node bfg-v1-probe.mjs wss://pop.hemi.network/v1/ws/public
>> {"header":{"command":"secp256k1-hello","id":"Hello:02dbe92a…876c"},"payload":{"userAgent":"hemi-agent-receipts-research/0.1","publickey":"02dbe92a…876c"}}
<< {"header":{"command":"secp256k1-hello-challenge","id":"HelloChallenge:02dbe92a…876c"},"payload":{"message":"8159a4acbd09c63cb54ef6de9303d884 48656c6c6f3a20…0a"}}
>> {"header":{"command":"secp256k1-hello-challenge-accepted","id":"HelloChallengeAccepted:02dbe92a…876c"},"payload":{"signature":"1fe04f03…4bb52f"}}
<< {"header":{"command":"bfgapi-ping-request","id":"0"},"payload":{"timestamp":1793316405}}
>> {"header":{"command":"bfgapi-bitcoin-info-request","id":"1"},"payload":{}}
<< {"header":{"command":"bfgapi-bitcoin-info-response","id":"1"},"payload":{"height":973750}}
>> {"header":{"command":"bfgapi-l2-keystones-request","id":"2"},"payload":{"num_l2_keystones":3}}
<< {"header":{"command":"bfgapi-l2-keystones-response","id":"2"},"payload":{"l2_keystones":[{"version":1,"l1_block_number":26301664,"l2_block_number":5620800,"parent_ep_hash":"7ee804a8…fc54","prev_ep_keystone_hash":"b6f0bc3d…af92","state_root":"3b8d06b2…1d8e","ep_hash":"24171666…064a"}, …5620775…, …5620750…]}}
closed 1005

$ node bfg-v1-probe.mjs wss://pop.hemi.network/v1/ws/public 'bfgapi-btc-finality-by-recent-keystones-request={"num_recent_keystones":2}'
… >> {"header":{"command":"bfgapi-btc-finality-by-recent-keystones-request","id":"3"},"payload":{"num_recent_keystones":2}}
closed 1000          # server drops the connection (same for bfgapi-pop-txs-for-l2-block-request)
```

You do not need it for the recommended method. It is an optional cross-check of the keystone list and the
BTC height. Testnet has no BFG:

- `https://testnet.pop.hemi.network/*` returns Cloudflare `error code: 526`.
- `https://testnet.rpc.hemi.network/v1/ws/public` returns 403
  `{"error": "Testnet BFG endpoint has moved to: https://testnet.pop.hemi.network/v1/ws/public - PoP Mining on testnet is no longer incentivised"}`.

### 6.4 Other dead ends (one line each)

- **bfgd v2 HTTP** (`GET /v2/keystonefinality/{hash}`, `heminetwork@dcaafba` `api/bfgapi/bfgapi.go`, default `localhost:8080`): `https://pop.hemi.network/v2/keystonefinality/…` returns nginx 404. No other public host found.
- **DNS check:** `bfg.hemi.network`, `testnet.bfg.hemi.network`, `bfg.hemi.xyz`, `finality.hemi.{network,xyz}`, `api.hemi.{network,xyz}`, `pop.hemi.xyz`, `tbc.hemi.network`, `portal-backend.hemi.xyz` have no records. `portal-api.hemi.xyz` exists but has no finality routes in its source.
- **op-geth `kss_getLatestKeystones` / `kss_getKeystone` / `kss_subscribe("newKeystones")`:** `-32601` on the public HTTP and WS RPC (`/rpc`, `/wsrpc`) and on dRPC. The `rpc_modules` result has no `kss`, `debug` or `admin`.
- **`safe` / `finalized` tags:** standard OP-stack (Ethereum L1-derived). No Bitcoin meaning.
- **Hemi Portal (`hemilabs/ui-monorepo`):** no BFG or finality calls. The `portal-backend` "latest-keystone" field is just `eth_blockNumber`.
- **hemi-node compose (`hemilabs/hemi-node`):** still pins bfgd 1.6.3 with private `ws://bfgd:8080/v1/ws/private`. It documents that "Extended Consensus RPC (BTC finality)" exists only on self-hosted `full`/`hemi` profiles.
- **Hemi docs** (`docs.hemi.xyz/llms.txt`, `llms-full.txt`): no public finality API. The only BFG URL is the PoP-miner websocket.
- **PoPPayoutsV2** (`hemilabs/pop-payouts`, with relative publication heights): not deployed. The live payouts use the V1 selector `0x1725877d`, so there are no BTC heights on-chain.
- **hVM:** no precompile looks up keystones. `0x40`–`0x49` cover balances, UTXOs, tx-by-txid, confirmations, headers, address→script, inputs/outputs and witness (`core/vm/contracts.go`).

---

## 7. Commands run (abridged; outputs above)

```text
git clone --depth 1 github.com/hemilabs/{heminetwork,hemi-node,ui-monorepo,blockscout-config,HemiConnector,hemi-viem,pop-payouts}
git clone --depth 1 --branch v1.6.3 github.com/hemilabs/heminetwork; sparse clones of hemilabs/optimism (hemi, 7c70d2d) and hemilabs/op-geth
gh api repos/hemilabs/optimism/contents/op-node/node/{api.go,bvm_api_helper.go}?ref={086fd45e2,6ca664e63,clayton/finality-bfg}
git clone --depth 1 --branch production-hemi github.com/hemilabs/blockscout
curl docs.hemi.xyz/llms.txt (9.5 KB), llms-full.txt (254 KB)
rpc <net>/rpc rpc_modules | kss_getLatestKeystones | eth_getBlockByNumber latest/safe/finalized | eth_call 0x43/0x44
rpc <net>/noderpc optimism_btcFinalityByBlockHash / optimism_btcFinalityByRecentKeystones / optimism_syncStatus / optimism_version
node wsrpc.mjs wss://{,testnet.}rpc.hemi.network/wsrpc rpc_modules kss_subscribe kss_getLatestKeystones
curl https://{pop,testnet.pop,testnet.rpc,rpc}.hemi.network/{,v1/ws/public,v1/ws/private,v2/keystonefinality/…}
node bfg-v1-probe.mjs wss://pop.hemi.network/v1/ws/public [finality cmds]
curl testnet.explorer.hemi.xyz/api/v2/{blocks/<n>,transactions/<h>,stats,config/backend-version,main-page/indexing-status}, /assets/envs.js
python3 -I keystone.py <rpc> <block>; find_pop.py / find_pop_sparse.py <esplora> <payload|magic> …; status_probe.py …; cadence.py …
cast calldata-decode 'mintPoPRewards(uint64,address[],uint32[])' <payout input>; cast keccak <uncompressed pubkey>
```

Total load: about 400 Hemi RPC calls over about 70 min, always with ≥ 0.25 s spacing. About 120 of them
went to the 120-day payout sample.

---

## 8. Open questions and risks

1. **Is there a supported public finality API?** Ask Hemi:
   - Whether a public bfgd v2 base URL exists to pass to `/noderpc`.
   - Whether `optimism_btcFinalityByBlockHash` will be fixed. Its current shape breaks their own Blockscout.
   - Whether testnet PoP will return.
2. **PoP liveness on mainnet.** The product must show `btc-published` as possibly days away during PoP
   outages. Add the payout-based liveness gate (§3.6) and surface it in the UI.
3. **Miner discovery.** A mode-A-only client misses new or rotated miners. Payout recipients are EVM
   addresses and cannot be mapped to Bitcoin addresses without seeing a PoP tx, so keep mode B (or
   periodic mode-B discovery).
4. **Trust.** Esplora (blockstream.info / mempool.space) is trusted for Bitcoin data. The hVM `0x43` result
   is trusted to the Hemi RPC operator. Cross-checking the two is cheap (1 call each), and they agreed in
   every sample. Bitcoin reorgs of the publication block are possible below 9 confirmations, so re-check
   the PoP txid's `status.block_hash` on each poll until final.
5. **bfgd v1 vs v2 semantics.** The "final" thresholds differ (9 vs 11 confirmations; §2.3). Confirm with
   Hemi which number they call "Bitcoin finality" in product terms.
6. **Mainnet explorer** `btc_finality` not checked (ISP block). Low priority given the root cause in §6.2.
7. **Estimate quality.** The §4 percentiles come from about 70 h of one miner. Refresh them periodically
   with `cadence.py`.
