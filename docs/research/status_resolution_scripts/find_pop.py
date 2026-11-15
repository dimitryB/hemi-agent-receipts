#!/usr/bin/env python3
"""Find the Bitcoin PoP transaction(s) that publish a given Hemi keystone.

usage: python3 -I find_pop.py <esplora-base> <pop_payload_hex> <keystone_unix_ts> [max_blocks]
  esplora-base e.g. https://mempool.space/api  (mainnet) or https://mempool.space/testnet4/api
Scans Bitcoin blocks whose timestamp >= keystone_ts - 2h (BTC timestamps can lag),
downloading each raw block once (GET /block/:hash/raw) and searching it for the
80-byte payload "HEMI"||abrev (the OP_RETURN push of a PoP tx). Parses the block
to report the txid. Sleeps between requests.
"""
import hashlib, json, sys, time, urllib.request, urllib.error

def get(url, raw=False):
    req = urllib.request.Request(url, headers={"user-agent": "hemi-agent-receipts-research"})
    for attempt in range(6):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                b = r.read()
            break
        except (urllib.error.HTTPError, TimeoutError) as e:
            if (isinstance(e, urllib.error.HTTPError) and e.code != 429) or attempt == 5: raise
            time.sleep(15 * (attempt + 1))
    time.sleep(0.6)
    return b if raw else json.loads(b) if b[:1] in b"[{" else b.decode()

def varint(b, i):
    x = b[i]
    if x < 0xfd: return x, i + 1
    if x == 0xfd: return int.from_bytes(b[i+1:i+3], "little"), i + 3
    if x == 0xfe: return int.from_bytes(b[i+1:i+5], "little"), i + 5
    return int.from_bytes(b[i+1:i+9], "little"), i + 9

def txs(block):
    """yield (txid_hex, start, end) for each tx in a raw block"""
    n, i = varint(block, 80)
    for _ in range(n):
        start = i
        i += 4  # version
        segwit = block[i] == 0 and block[i+1] == 1
        if segwit: i += 2
        nin, i = varint(block, i)
        ins_start = i
        for _ in range(nin):
            i += 36; l, i = varint(block, i); i += l + 4
        nout, i = varint(block, i)
        for _ in range(nout):
            i += 8; l, i = varint(block, i); i += l
        io_end = i
        if segwit:
            for _ in range(nin):
                k, i = varint(block, i)
                for _ in range(k):
                    l, i = varint(block, i); i += l
        i += 4  # locktime
        if segwit:
            # txid = dsha256(version || inputs/outputs (without marker/flag) || locktime)
            ser = block[start:start+4] + block[start+6:io_end] + block[i-4:i]
        else:
            ser = block[start:i]
        yield hashlib.sha256(hashlib.sha256(ser).digest()).digest()[::-1].hex(), start, i

if __name__ == "__main__":
    base, payload, ks_ts = sys.argv[1], bytes.fromhex(sys.argv[2]), int(sys.argv[3])
    max_blocks = int(sys.argv[4]) if len(sys.argv) > 4 else 30
    tip = int(get(f"{base}/blocks/tip/height"))
    # walk back to the first block with timestamp < ks_ts - 7200
    h = tip
    while True:
        blks = get(f"{base}/blocks/{h}")  # 10 blocks, descending
        if blks[-1]["timestamp"] < ks_ts - 7200: break
        h = blks[-1]["height"] - 1
    start = min(b["height"] for b in blks if b["timestamp"] >= ks_ts - 7200) if any(b["timestamp"] >= ks_ts - 7200 for b in blks) else blks[0]["height"] + 1
    print(json.dumps({"btc_tip": tip, "scan_from": start}))
    found = []
    for height in range(start, min(tip, start + max_blocks - 1) + 1):
        bh = get(f"{base}/block-height/{height}")
        raw = get(f"{base}/block/{bh}/raw", raw=True)
        hdr_ts = int.from_bytes(raw[68:72], "little")
        pos = raw.find(payload)
        hits = []
        if pos >= 0:
            for txid, s, e in txs(raw):
                if s <= pos < e: hits.append(txid)
        print(json.dumps({"height": height, "hash": bh, "time": hdr_ts, "size": len(raw), "pop_txids": hits}))
        if hits: found.append((height, hits))
    print(json.dumps({"found": found, "btc_tip": tip}))
