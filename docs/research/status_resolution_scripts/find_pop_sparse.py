#!/usr/bin/env python3
"""Like find_pop.py but walks esplora /blocks/:h listings (10 blocks/call) from a
start height and only downloads raw blocks whose tx_count > 1 (for testnet3
block storms). usage: find_pop_sparse.py <esplora> <payload_hex> <start_height> <max_height>"""
import sys, json, time
sys.path.insert(0, __import__('os').path.dirname(__import__('os').path.abspath(__file__)))
from find_pop import get, txs
base, payload, start, stop = sys.argv[1], bytes.fromhex(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4])
h = start + 9
found, fetched, seen = [], 0, 0
while h - 9 <= stop:
    for b in sorted(get(f"{base}/blocks/{min(h, stop)}"), key=lambda b: b["height"]):
        if b["height"] < start or b["height"] > stop: continue
        seen += 1
        if b["tx_count"] <= 1: continue
        raw = get(f"{base}/block/{b['id']}/raw", raw=True); fetched += 1
        pos = raw.find(payload)
        if pos >= 0:
            hits = [t for t, s, e in txs(raw) if s <= pos < e]
            print(json.dumps({"height": b["height"], "time": b["timestamp"], "tx_count": b["tx_count"], "pop_txids": hits})); found.append(b["height"])
    h += 10
print(json.dumps({"scanned_blocks": seen, "raw_fetched": fetched, "found_heights": found}))
