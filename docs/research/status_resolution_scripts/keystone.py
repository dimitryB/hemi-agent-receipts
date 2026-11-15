#!/usr/bin/env python3
"""Derive a Hemi L2 keystone from public JSON-RPC data and compute its
abbreviated form / hash exactly as heminetwork hemi/hemi.go does.

usage: python3 -I keystone.py <rpc-url> <l2-block-number>
  prints: covering keystone height, full keystone JSON, 76-byte abrev hex,
  the 80-byte PoP OP_RETURN payload ("HEMI"+abrev), and the abrev hash in
  chainhash display order (byte-reversed double-SHA256), which is what
  bfgd v2 GET /v2/keystonefinality/{hash} and op-node expect.
"""
import hashlib, json, sys, time, urllib.request

PERIOD = 25  # hemi.KeystoneHeaderPeriod

def rpc(url, method, params):
    req = urllib.request.Request(url, data=json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode(),
                                 headers={"content-type": "application/json", "user-agent": "hemi-agent-receipts-research"})
    with urllib.request.urlopen(req, timeout=30) as r:
        out = json.load(r)
    if "error" in out:
        raise RuntimeError(out["error"])
    return out["result"]

def block(url, n, full=False):
    b = rpc(url, "eth_getBlockByNumber", [hex(n), full]); time.sleep(0.3); return b

def l1_origin_number(blk):
    # first tx of every OP-stack block is the L1-info deposit to 0x4200...0015.
    tx = blk["transactions"][0]
    assert tx["to"].lower() == "0x4200000000000000000000000000000000000015", tx["to"]
    data = bytes.fromhex(tx["input"][2:])
    # Ecotone/Isthmus packed layout: sel(4) baseFeeScalar(4) blobBaseFeeScalar(4) seq(8) ts(8) number(8) ...
    return int.from_bytes(data[28:36], "big")

def keystone_for(url, n):
    k = n if n % PERIOD == 0 else n + (PERIOD - n % PERIOD)  # op-node getKeystoneProvidingFinality
    kb = block(url, k, True)
    pb = block(url, k - PERIOD, False)
    ks = {
        "version": 1,
        "l1_block_number": l1_origin_number(kb),
        "l2_block_number": k,
        "parent_ep_hash": kb["parentHash"][2:],
        "prev_ep_keystone_hash": pb["hash"][2:],
        "state_root": kb["stateRoot"][2:],
        "ep_hash": kb["hash"][2:],
    }
    return k, ks, int(kb["timestamp"], 16)

def abbreviate(ks):
    b = bytes([ks["version"]]) + ks["l1_block_number"].to_bytes(4, "big") + ks["l2_block_number"].to_bytes(4, "big")
    b += bytes.fromhex(ks["parent_ep_hash"])[:11]
    b += bytes.fromhex(ks["prev_ep_keystone_hash"])[:12]
    b += bytes.fromhex(ks["state_root"])[:32]
    b += bytes.fromhex(ks["ep_hash"])[:12]
    assert len(b) == 76
    return b

def abrev_hash_display(abrev):
    h = hashlib.sha256(hashlib.sha256(abrev).digest()).digest()
    return h[::-1].hex()  # chainhash.Hash.String() is byte-reversed

if __name__ == "__main__":
    url, n = sys.argv[1], int(sys.argv[2], 0)
    k, ks, ts = keystone_for(url, n)
    ab = abbreviate(ks)
    print(json.dumps({"query_block": n, "keystone_block": k, "keystone_timestamp": ts, "keystone": ks,
                      "abrev_hex": ab.hex(), "pop_payload_hex": (b"HEMI" + ab).hex(),
                      "pop_opreturn_script_hex": "6a4c50" + (b"HEMI" + ab).hex(),
                      "abrev_hash": abrev_hash_display(ab)}, indent=1))
