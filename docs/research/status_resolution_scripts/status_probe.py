#!/usr/bin/env python3
"""Reference probe: resolve the PoP status of a Hemi tx using only public endpoints.

usage: python3 -I status_probe.py <hemi-rpc> <esplora-base> <txhash> [pop-miner-btc-address ...]

Stages: pending -> hemi-included -> hemi-confirmed (block <= `safe` head) ->
btc-published (an on-Bitcoin PoP tx carries the canonical keystone covering the
block, or a descendant keystone) -> btc-final (that BTC block has >= 9 confirmations).

Bitcoin-side lookup here uses PoP-miner address polling (esplora /address/:a/txs);
a production indexer should also scan new BTC blocks (see find_pop.py) to
discover miners it does not know yet.
"""
import hashlib, json, sys, time, urllib.request, urllib.error

PERIOD, FINAL_CONFS = 25, 9
MAGIC_SCRIPT = "6a4c5048454d49"  # OP_RETURN OP_PUSHDATA1 0x50 "HEMI"
calls = {"hemi_rpc": 0, "esplora": 0}

def http(url, body=None):
    req = urllib.request.Request(url, data=body, headers={"content-type": "application/json", "user-agent": "hemi-agent-receipts-research"})
    for attempt in range(5):
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return r.read()
        except (urllib.error.HTTPError, TimeoutError) as e:
            if (isinstance(e, urllib.error.HTTPError) and e.code != 429) or attempt == 4: raise
            time.sleep(10 * (attempt + 1))

def rpc(url, method, params):
    calls["hemi_rpc"] += 1
    out = json.loads(http(url, json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()))
    time.sleep(0.25)
    if "error" in out: raise RuntimeError(out["error"])
    return out["result"]

def esplora(base, path):
    calls["esplora"] += 1
    b = http(base + path); time.sleep(0.5)
    return json.loads(b) if b[:1] in b"[{" else b.decode()

def abrev_of(rpc_url, k, cache={}):
    """canonical 76-byte abbreviated keystone for L2 keystone height k (2 RPC calls, cacheable forever once final)"""
    if k in cache: return cache[k]
    kb = rpc(rpc_url, "eth_getBlockByNumber", [hex(k), True])
    pb = rpc(rpc_url, "eth_getBlockByNumber", [hex(k - PERIOD), False])
    info = bytes.fromhex(kb["transactions"][0]["input"][2:])  # L1-info deposit (Ecotone/Isthmus packed)
    l1 = int.from_bytes(info[28:36], "big")
    ab = (bytes([1]) + l1.to_bytes(4, "big") + k.to_bytes(4, "big") + bytes.fromhex(kb["parentHash"][2:])[:11]
          + bytes.fromhex(pb["hash"][2:])[:12] + bytes.fromhex(kb["stateRoot"][2:]) + bytes.fromhex(kb["hash"][2:])[:12])
    cache[k] = ab
    return ab

def miner_publications(base, addr, min_l2):
    """{l2_keystone: [(btc_height|None, txid, abrev_bytes)]} for this miner, paging back until older than min_l2"""
    pubs, last = {}, None
    while True:
        page = esplora(base, f"/address/{addr}/txs" + (f"/chain/{last}" if last else ""))
        if not page: break
        oldest = None
        for tx in page:
            for v in tx["vout"]:
                if v["scriptpubkey"].startswith(MAGIC_SCRIPT) and len(v["scriptpubkey"]) == 2 * 83:
                    ab = bytes.fromhex(v["scriptpubkey"])[7:]
                    k = int.from_bytes(ab[5:9], "big")
                    h = tx["status"].get("block_height") if tx["status"]["confirmed"] else None
                    pubs.setdefault(k, []).append((h, tx["txid"], ab))
                    oldest = k if oldest is None else min(oldest, k)
        conf = [t for t in page if t["status"]["confirmed"]]
        if not conf or (oldest is not None and oldest < min_l2): break
        last = conf[-1]["txid"]
    return pubs

def main():
    rpc_url, base, txh, miners = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4:]
    r = {"tx": txh}
    rc = rpc(rpc_url, "eth_getTransactionReceipt", [txh])
    if rc is None:
        r["stage"] = "pending"; return r
    B = int(rc["blockNumber"], 16); r.update(block=B, block_hash=rc["blockHash"], status=rc["status"])
    canon = rpc(rpc_url, "eth_getBlockByNumber", [hex(B), False])["hash"]
    if canon != rc["blockHash"]:
        r["stage"] = "pending"; r["note"] = "receipt block is no longer canonical (reorg)"; return r
    latest = int(rpc(rpc_url, "eth_blockNumber", []), 16)
    safe = int(rpc(rpc_url, "eth_getBlockByNumber", ["safe", False])["number"], 16)
    r.update(latest=latest, safe=safe, hemi_confirmations=latest - B + 1)
    r["stage"] = "hemi-confirmed" if B <= safe else "hemi-included"
    K = B if B % PERIOD == 0 else B + PERIOD - B % PERIOD
    r["covering_keystone"] = K
    if K > latest:
        r["btc"] = "covering keystone not produced yet"; return r
    pubs = {}
    for a in miners:
        for k, lst in miner_publications(base, a, K).items():
            pubs.setdefault(k, []).extend(lst)
    # effective publication: lowest BTC height among K and its descendants that carry the canonical abrev.
    # Try candidates in (btc_height, l2) order and verify only until the first canonical one (usually 2 RPC calls).
    confirmed = sorted((h, k, txid, ab) for k, lst in pubs.items() if k >= K for h, txid, ab in lst if h is not None)
    best = next(((h, k, txid) for h, k, txid, ab in confirmed if ab == abrev_of(rpc_url, k)), None)
    mempool = [(k, txid) for k, lst in sorted(pubs.items()) if k >= K for h, txid, ab in lst if h is None][:3]
    if best is None:
        r["btc"] = {"published": False, "in_btc_mempool": mempool[:3]}
        return r
    tip = int(esplora(base, "/blocks/tip/height"))
    h, k, txid = best
    confs = tip - h + 1
    r["btc"] = {"published": True, "via_keystone": k, "inherited": k != K, "pop_txid": txid, "pub_height": h,
                "btc_tip": tip, "confirmations": confs, "btc_finality_v1": min(confs - FINAL_CONFS, 100)}
    r["stage"] = "btc-final" if confs >= FINAL_CONFS else "btc-published"
    return r

if __name__ == "__main__":
    out = main(); out["calls"] = calls
    print(json.dumps(out, indent=1))
