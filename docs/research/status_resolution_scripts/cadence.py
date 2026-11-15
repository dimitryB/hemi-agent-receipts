#!/usr/bin/env python3
"""Measure mainnet keystone publication cadence from one PoP miner's address history.
usage: cadence.py <esplora> <btc_address> <hours> <ref_l2_block> <ref_l2_ts>"""
import sys, json, time, statistics as st
sys.path.insert(0, __import__('os').path.dirname(__import__('os').path.abspath(__file__)))
from find_pop import get
base, addr, hours, ref, ref_ts = sys.argv[1], sys.argv[2], float(sys.argv[3]), int(sys.argv[4]), int(sys.argv[5])
now = int(time.time()); cutoff = now - int(hours * 3600)
pubs, mempool, last, pages = {}, [], None, 0
while True:
    url = f"{base}/address/{addr}/txs" + (f"/chain/{last}" if last else "")
    page = get(url); pages += 1
    if not page: break
    stop = False
    for tx in page:
        op = [v["scriptpubkey"] for v in tx["vout"] if v["scriptpubkey"].startswith("6a4c5048454d49")]
        if not op: continue
        ab = bytes.fromhex(op[0])[7:]
        k = int.from_bytes(ab[5:9], "big")
        s = tx["status"]
        if not s["confirmed"]:
            mempool.append(k); continue
        if s["block_time"] < cutoff: stop = True; continue
        prev = pubs.get(k)
        if prev is None or s["block_height"] < prev[0]: pubs[k] = (s["block_height"], s["block_time"], tx["txid"])
    confirmed = [t for t in page if t["status"]["confirmed"]]
    if stop or not confirmed: break
    last = confirmed[-1]["txid"]
heights = sorted({h for h, _, _ in pubs.values()})
btime = {}
need = set(range(min(heights), max(heights) + 10)) if heights else set()
h = max(need) if need else 0
tip = int(get(f"{base}/blocks/tip/height"))
while need and h >= min(need):
    hh = min(h, tip)
    for b in get(f"{base}/blocks/{hh}"): btime[b["height"]] = b["timestamp"]
    h = hh - 10
rows = []
for k, (bh, bt, txid) in sorted(pubs.items()):
    kts = ref_ts + (k - ref) * 12
    fin_h = bh + 8
    rows.append({"k": k, "k_ts": kts, "pub_h": bh, "pub_delay_s": bt - kts,
                 "final_delay_s": (btime[fin_h] - kts) if fin_h in btime and fin_h <= tip else None})
ks = sorted(pubs)
expected = list(range(ks[0], ks[-1] + 1, 25)) if ks else []
missing = [k for k in expected if k not in pubs]
pd = [r["pub_delay_s"] for r in rows]; fd = [r["final_delay_s"] for r in rows if r["final_delay_s"] is not None]
q = lambda xs, p: sorted(xs)[min(len(xs) - 1, int(p * len(xs)))]
print(json.dumps({"pages": pages, "published_keystones": len(ks), "first": ks[0] if ks else None, "last": ks[-1] if ks else None,
  "missing_in_range": len(missing), "missing_sample": missing[:10], "mempool_unconfirmed": sorted(mempool),
  "pub_delay_min": {"min": min(pd)/60, "p50": q(pd,.5)/60, "p90": q(pd,.9)/60, "p99": q(pd,.99)/60, "max": max(pd)/60},
  "final_delay_min": {"n": len(fd), "min": min(fd)/60, "p50": q(fd,.5)/60, "p90": q(fd,.9)/60, "max": max(fd)/60} if fd else None,
  "btc_blocks_with_pubs": len(heights), "btc_span": [heights[0], heights[-1]] if heights else None}, indent=1))
json.dump(rows, open('cadence-rows.json', 'w'))
