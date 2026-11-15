import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  createPopFinalityReader,
  defaultFinalityReader,
  EsploraClient,
  EsploraError,
  keystoneAbrev,
  popLiveness,
  describeLivenessWindow,
  popOpReturnScript,
  resolveStatus,
  unavailableFinality,
  type EsploraTx,
  type FetchLike,
  type PopFinalityReader,
} from "../src/index.js";
import { ESPLORA, fakeEsplora, fakeHemi, MAINNET_BLOCKS, MINER, POP_TXID, popTx, rawBlock, TESTNET } from "./finality-fakes.js";
import type { Hex, PublicClient } from "viem";

const H973746 = ESPLORA.blockHeight["973746"]!;
const fast = { requestsPerSecond: 1_000, burst: 100, retryDelayMs: 1 };
const mainnet = (latest = 5_620_740) => fakeHemi({ chainId: 43_111, blocks: MAINNET_BLOCKS, latest });
const anchor = (n: number) => ({ blockNumber: BigInt(n), blockHash: MAINNET_BLOCKS[String(n)]!.hash, blockTimestamp: Number(MAINNET_BLOCKS[String(n)]!.timestamp) });
const btcHash = (h: number) => `${"0".repeat(56)}${h.toString(16).padStart(8, "0")}`;

function reader(fetch: FetchLike, extra: Partial<Parameters<typeof createPopFinalityReader>[0]> = {}) {
  return createPopFinalityReader({ esploraUrls: ["https://esplora.invalid/api"], minerAddresses: [MINER], esplora: { ...fast, fetch }, ...extra });
}

async function canonicalScript(l2: number): Promise<string> {
  return popOpReturnScript((await keystoneAbrev(mainnet(), l2)).abrev).slice(2);
}

describe("publication from recorded miner history (mode A)", () => {
  test("block 5620209: keystone 5620225 published directly in BTC 973746 by d4ed6ec2…845e", async () => {
    const esplora = fakeEsplora({ tip: ESPLORA.tip, pages: { [MINER]: ESPLORA.addressPages }, blockHeight: ESPLORA.blockHeight });
    const btc = await reader(esplora).read({ ...anchor(5_620_209), client: mainnet() });
    assert.equal(btc.source, "bitcoin");
    assert.equal(btc.coveringKeystone, 5_620_225);
    assert.equal(btc.viaKeystone, 5_620_225);
    assert.equal(btc.inherited, false);
    assert.equal(btc.publishedAtBtcHeight, 973_746);
    assert.equal(btc.popTxid, POP_TXID);
    assert.equal(btc.btcConfirmations, ESPLORA.tip - 973_746 + 1);
    assert.equal(btc.btcBlockHash, H973746);
    assert.equal(btc.superFinal, btc.btcConfirmations! >= 11);
    assert.ok(esplora.paths.includes("/block-height/973746"), "below 9 confirmations the block hash is re-checked");
  });

  test("at 9+ confirmations the reorg re-check is skipped", async () => {
    const esplora = fakeEsplora({ tip: 973_756, pages: { [MINER]: ESPLORA.addressPages } });
    const btc = await reader(esplora).read({ ...anchor(5_620_209), client: mainnet() });
    assert.equal(btc.btcConfirmations, 11);
    assert.equal(btc.superFinal, true);
    assert.ok(!esplora.paths.some((p) => p.startsWith("/block-height")));
  });

  test("block 5619605: keystone 5619625 was never published; it inherits keystone 5619825's publication in BTC 973739", async () => {
    const esplora = fakeEsplora({ tip: ESPLORA.tip, pages: { [MINER]: ESPLORA.addressPages } });
    const btc = await reader(esplora).read({ ...anchor(5_619_605), client: mainnet() });
    assert.equal(btc.source, "bitcoin");
    assert.equal(btc.coveringKeystone, 5_619_625);
    assert.equal(btc.viaKeystone, 5_619_825);
    assert.equal(btc.inherited, true);
    assert.equal(btc.publishedAtBtcHeight, 973_739);
    assert.equal(btc.popTxid, "ebecd1a546f1b406d9ee35aceba8d563340c95ee153970962c32721b26f807a5");
    assert.match(btc.detail!, /keystone 5619825 \(a descendant of covering keystone 5619625\) published in Bitcoin block 973739/);
  });
});

describe("publication selection rules", () => {
  test("the lowest confirmed height wins, even through a descendant keystone", async () => {
    const s250 = await canonicalScript(5_620_250);
    const pages = { [MINER]: [{ after: null, txs: [...ESPLORA.addressPages[0]!.txs, popTx("aa".repeat(32), s250, { confirmed: true, block_height: 973_745, block_hash: btcHash(973_745) })] }] };
    const esplora = fakeEsplora({ tip: 973_756, pages });
    const btc = await reader(esplora).read({ ...anchor(5_620_209), client: mainnet() });
    assert.equal(btc.publishedAtBtcHeight, 973_745);
    assert.equal(btc.viaKeystone, 5_620_250);
    assert.equal(btc.inherited, true);
    assert.equal(btc.popTxid, "aa".repeat(32));
  });

  test("a non-canonical HEMI OP_RETURN for the right keystone is ignored", async () => {
    const real = await canonicalScript(5_620_225);
    const forged = `${real.slice(0, -2)}${real.endsWith("00") ? "01" : "00"}`; // same l2, last abrev byte changed
    const pages = { [MINER]: [{ after: null, txs: [popTx("bb".repeat(32), forged, { confirmed: true, block_height: 973_740, block_hash: btcHash(973_740) }), ...ESPLORA.addressPages[0]!.txs] }] };
    const esplora = fakeEsplora({ tip: 973_756, pages });
    const btc = await reader(esplora).read({ ...anchor(5_620_209), client: mainnet() });
    assert.equal(btc.publishedAtBtcHeight, 973_746, "the forged lower publication does not count");
    assert.equal(btc.popTxid, POP_TXID);
    assert.match(btc.detail!, /ignored 1 "HEMI" OP_RETURN that do not match the canonical keystone/);
  });

  test("a forged low keystone in the mempool does not end the miner-history search early", async () => {
    // Anyone can put a transaction into a miner's address history (dust to the address with a
    // "HEMI" OP_RETURN), and a mempool entry costs nothing. One naming an old keystone used to
    // end pagination on the first page, so the genuine publication on the next page was never
    // read and a newer descendant's publication (5 confirmations) was reported instead (11).
    const forgedAbrev = `0x${"00".repeat(5)}${(5_000_000).toString(16).padStart(8, "0")}${"00".repeat(76 - 9)}` as Hex;
    const forged = popOpReturnScript(forgedAbrev).slice(2);
    const s250 = await canonicalScript(5_620_250);
    const descendant = popTx("aa".repeat(32), s250, { confirmed: true, block_height: 973_752, block_hash: btcHash(973_752) });
    const pages = {
      [MINER]: [
        { after: null, txs: [popTx("ff".repeat(32), forged, { confirmed: false }), descendant] },
        { after: "aa".repeat(32), txs: ESPLORA.addressPages[0]!.txs },
      ],
    };
    const esplora = fakeEsplora({ tip: 973_756, pages });
    const btc = await reader(esplora).read({ ...anchor(5_620_209), client: mainnet() });
    assert.equal(btc.publishedAtBtcHeight, 973_746, "the genuine publication on the second page wins");
    assert.equal(btc.viaKeystone, 5_620_225);
    assert.equal(btc.btcConfirmations, 11);
    assert.equal(esplora.paths.filter((p) => p.startsWith(`/address/${MINER}/txs`)).length, 3, "both pages read, then the end of the history");
  });

  test("unconfirmed publications do not count; they only show in the detail", async () => {
    const real = await canonicalScript(5_620_225);
    const pages = { [MINER]: [{ after: null, txs: [popTx("cc".repeat(32), real, { confirmed: false })] }] };
    const esplora = fakeEsplora({ tip: 973_756, pages });
    const btc = await reader(esplora).read({ ...anchor(5_620_209), client: mainnet() });
    assert.equal(btc.publishedAtBtcHeight, undefined);
    assert.equal(btc.source, "estimate", "block 5620725 carries a PoP payout: PoP is live");
    assert.match(btc.detail!, new RegExp(`in Bitcoin mempool: keystone 5620225 in tx ${"cc".repeat(32)}`));
  });

  test("a Bitcoin reorg of the publication block is followed to the tx's new block", async () => {
    const real = await canonicalScript(5_620_225);
    const txid = "dd".repeat(32);
    const pages = { [MINER]: [{ after: null, txs: [popTx(txid, real, { confirmed: true, block_height: 973_746, block_hash: btcHash(1) })] }] };
    const moved: EsploraTx = popTx(txid, real, { confirmed: true, block_height: 973_748, block_hash: btcHash(973_748) });
    const esplora = fakeEsplora({ tip: 973_750, pages, blockHeight: { 973_746: btcHash(973_746), 973_748: btcHash(973_748) }, tx: { [txid]: moved } });
    const btc = await reader(esplora).read({ ...anchor(5_620_209), client: mainnet() });
    assert.equal(btc.publishedAtBtcHeight, 973_748);
    assert.equal(btc.btcConfirmations, 3);
    assert.match(btc.detail!, /Bitcoin block 973746 was reorged/);
  });

  test("a reorged-out publication that is no longer confirmed is dropped", async () => {
    const real = await canonicalScript(5_620_225);
    const txid = "ee".repeat(32);
    const pages = { [MINER]: [{ after: null, txs: [popTx(txid, real, { confirmed: true, block_height: 973_746, block_hash: btcHash(1) })] }] };
    const esplora = fakeEsplora({ tip: 973_750, pages, blockHeight: { 973_746: btcHash(973_746) }, tx: { [txid]: popTx(txid, real, { confirmed: false }) } });
    const btc = await reader(esplora).read({ ...anchor(5_620_209), client: mainnet() });
    assert.equal(btc.publishedAtBtcHeight, undefined);
    assert.notEqual(btc.source, "bitcoin");
  });
});

describe("raw block scan (mode B)", () => {
  function scanning(tip = 973_756) {
    const times = (h: number) => 1_793_309_506 + (h - 973_746) * 600;
    const coinbase = ESPLORA.txHex[ESPLORA.coinbaseTxid]!;
    const blockHeight: Record<number, string> = {};
    const raw: Record<string, Uint8Array> = {};
    for (let h = 973_700; h <= 973_756; h++) {
      blockHeight[h] = h === 973_746 ? H973746 : btcHash(h);
      raw[blockHeight[h]!] = rawBlock(times(h), h === 973_746 ? [coinbase, ESPLORA.txHex[POP_TXID]!] : [coinbase]);
    }
    const data = { tip, blockHeight, raw, blockTimes: times };
    const esplora = fakeEsplora(data);
    const r = reader(esplora, { minerAddresses: [], scanMaxBlocks: 10 });
    const client = mainnet();
    return {
      data, esplora, coinbase, times,
      read: () => r.read({ ...anchor(5_620_209), client }),
      status: () => resolveStatus({ client, blockNumber: 5_620_209n, safeBlock: null, finality: r }),
    };
  }

  test("finds the PoP tx by scanning from t_K − 10 min, with no miner list, and caches scanned heights", async () => {
    const { read, esplora, data: { blockHeight } } = scanning();
    const btc = await read();
    assert.equal(btc.source, "bitcoin");
    assert.equal(btc.publishedAtBtcHeight, 973_746);
    assert.equal(btc.popTxid, POP_TXID);
    const rawFetches = esplora.paths.filter((p) => p.endsWith("/raw"));
    assert.deepEqual(rawFetches, [`/block/${blockHeight[973_745]}/raw`, `/block/${H973746}/raw`], "starts at the first block at or after t_K − 10 min");
    const checked = esplora.paths.length;
    await read();
    assert.equal(esplora.paths.filter((p) => p.endsWith("/raw")).length, 2, "deep scanned heights are cached");
    assert.ok(!esplora.paths.slice(checked).some((p) => p.startsWith("/block-height/")), "hashes already checked at super-final depth are cached");
  });

  for (const moved of [false, true]) {
    test(`a cached young publication ${moved ? "moved by a reorg keeps its new confirmation count" : "removed by a reorg does not become final"} after a gap between reads`, async () => {
      const s = scanning(973_746);
      assert.equal((await s.status()).stage, "btc-published");
      // A one-block reorg happens now, then ten blocks pass before the next read.
      const replacement = "ff".repeat(32);
      s.data.blockHeight[973_746] = replacement;
      s.data.raw[replacement] = rawBlock(s.times(973_746), [s.coinbase]);
      if (moved) {
        s.data.raw[s.data.blockHeight[973_752]!] = rawBlock(s.times(973_752), [s.coinbase, ESPLORA.txHex[POP_TXID]!]);
      }
      s.data.tip = 973_756;
      const checked = s.esplora.paths.length;
      const status = await s.status();
      assert.ok(s.esplora.paths.slice(checked).includes("/block-height/973746"), "recheck the young cached hash before treating it as final");
      assert.equal(status.stage, moved ? "btc-published" : "hemi-confirmed");
      assert.equal(status.btc?.publishedAtBtcHeight, moved ? 973_752 : undefined);
      assert.equal(status.btc?.btcConfirmations, moved ? 5 : undefined);
    });
  }

  test("a young cached hash is checked once at super-final depth before further reads can reuse it", async () => {
    const s = scanning(973_746);
    await s.read();
    s.data.tip = 973_756;
    const checked = s.esplora.paths.length;
    assert.equal((await s.status()).stage, "btc-final");
    assert.ok(s.esplora.paths.slice(checked).includes("/block-height/973746"));
    const finalized = s.esplora.paths.length;
    await s.read();
    assert.ok(!s.esplora.paths.slice(finalized).includes("/block-height/973746"));
    assert.equal(s.esplora.paths.filter((p) => p.endsWith("/raw")).length, 2, "unchanged blocks do not need to be downloaded again");
  });
});

describe("liveness gate", () => {
  test("not live (testnet: no PoP payout in the recorded keystone blocks): unavailable, and Esplora is never called", async () => {
    const esplora = fakeEsplora({ tip: 1 });
    const client = fakeHemi({ chainId: 743_111, blocks: TESTNET.blocks, latest: TESTNET.latest });
    const lk = Math.floor(TESTNET.latest / 25) * 25;
    const anchorBlock = lk - 125; // keystone of a recent block; never fetched for its abrev
    // The fixture holds the 6 newest keystone blocks, so look at exactly those.
    const r = createPopFinalityReader({ esploraUrls: ["https://esplora.invalid/api"], esplora: { ...fast, fetch: esplora }, livenessWindowKeystones: 6, livenessStride: 1 });
    const btc = await r.read({ blockNumber: BigInt(anchorBlock - 3), blockHash: "0x00", blockTimestamp: 1_793_318_000, client });
    assert.equal(btc.source, "unavailable");
    assert.equal(btc.popLive, false);
    assert.equal(btc.detail, `no PoP activity: no PoP payout in 6 keystone blocks sampled over the last 30 min (blocks ${lk - 125}…${lk}); keystone ${anchorBlock} not searched on Bitcoin (no PoP miner addresses or block scan configured)`);
    assert.deepEqual(esplora.paths, []);
    assert.equal(client.calls.filter((c) => c.startsWith("eth_getBlockByNumber")).length, 6);
  });

  test("live (mainnet keystone block 5620725 pays the miners of 5620225): estimate with expected-by times", async () => {
    const esplora = fakeEsplora({ tip: 973_756, pages: { [MINER]: [{ after: null, txs: [] }] } });
    const btc = await reader(esplora).read({ ...anchor(5_620_209), client: mainnet() });
    const tK = 1_793_309_411; // timestamp of keystone block 5620225 = t_B + 16 × 12 s
    assert.equal(anchor(5_620_209).blockTimestamp + 16 * 12, tK);
    assert.equal(btc.source, "estimate");
    assert.equal(btc.popLive, true);
    assert.equal(btc.estimatedPublishedAt, tK + 15 * 60);
    assert.equal(btc.estimatedFinalAt, tK + 102 * 60);
    assert.match(btc.detail!, /PoP is live \(payout in keystone block 5620725\)\. ESTIMATE, not verified: published by ~2026-10-29T\d\d:\d\d:\d\dZ \(p50; p90 .*\), final by ~.* \(p50; p90 .*\)/);
    assert.equal(btc.publishedAtBtcHeight, undefined);
  });

  test("popLiveness checks keystone blocks newest first and stops at the first payout", async () => {
    const client = mainnet(5_620_749);
    const live = await popLiveness(client, 5_620_749n, 6);
    assert.deepEqual(live, { live: true, payoutBlock: 5_620_725, checked: [5_620_725], windowKeystones: 6 });
  });

  test("the default window spans 6 h, sampled every 4th keystone: a payout 2 h back still counts as live", async () => {
    // Synthetic chain: every keystone block is empty except one payout 2 h (24 keystones) back.
    const top = 5_621_325;
    const payoutAt = top - 24 * 25;
    const seen: number[] = [];
    const client = {
      async request({ params }: { params: [Hex, boolean] }) {
        const n = Number(BigInt(params[0]));
        seen.push(n);
        const payout = { from: "0x8888888888888888888888888888888888888888", input: "0x1725877d00", hash: "0x01" };
        return { number: params[0], transactions: n === payoutAt ? [payout] : [] };
      },
    } as unknown as PublicClient;
    const live = await popLiveness(client, BigInt(top + 7), { windowKeystones: 72, stride: 4 });
    assert.equal(live.live, true);
    assert.equal(live.payoutBlock, payoutAt);
    assert.deepEqual(seen, [0, 4, 8, 12, 16, 20, 24].map((i) => top - i * 25), "newest first, every 4th keystone, stops at the payout");
    const quiet = await popLiveness({ request: async ({ params }: { params: [Hex, boolean] }) => ({ number: params[0], transactions: [] }) } as unknown as PublicClient, BigInt(top), { windowKeystones: 72, stride: 4 });
    assert.equal(quiet.live, false);
    assert.equal(quiet.checked.length, 18, "72 keystones every 4th = 18 reads at most");
    assert.equal(describeLivenessWindow(72), "6 h");
    assert.equal(describeLivenessWindow(6), "30 min");
  });
});

describe("defaults and the Esplora client", () => {
  test("defaultFinalityReader: unavailable on a local chain, PoP readers on Hemi chains, shared per chain", () => {
    assert.equal(defaultFinalityReader(31_337), unavailableFinality);
    assert.notEqual(defaultFinalityReader(31_337, { esploraUrls: ["http://x.invalid"] }), unavailableFinality);
    const testnet = defaultFinalityReader(743_111);
    assert.equal(defaultFinalityReader(743_111), testnet);
    assert.notEqual(defaultFinalityReader(743_111, { scanMaxBlocks: 3 }), testnet);
    assert.deepEqual((defaultFinalityReader(43_111) as PopFinalityReader).esplora.baseUrls, ["https://blockstream.info/api", "https://mempool.space/api"]);
  });

  test("retries 429 and 5xx, moves to the next base URL, and does not retry other 4xx", async () => {
    const seen: string[] = [];
    let n = 0;
    const fetch: FetchLike = async (input) => {
      const url = String(input);
      seen.push(url);
      if (url.includes("/tx/")) return new Response("Transaction not found", { status: 404 });
      n++;
      if (n === 1) return new Response("slow down", { status: 429, headers: { "retry-after": "0" } });
      if (n === 2) return new Response("bad gateway", { status: 502 });
      return new Response("973756");
    };
    const client = new EsploraClient({ baseUrls: ["https://a.invalid/api", "https://b.invalid/api/"], fetch, ...fast });
    assert.equal(await client.tipHeight(), 973_756);
    assert.deepEqual(seen, ["https://a.invalid/api/blocks/tip/height", "https://b.invalid/api/blocks/tip/height", "https://a.invalid/api/blocks/tip/height"]);
    assert.equal(client.stats.retries, 2);
    assert.equal(await client.tx("ab".repeat(32)), null, "404 → null, not retried");
    const bad = new EsploraClient({ baseUrls: ["https://a.invalid/api"], fetch: async () => new Response("no", { status: 400 }), ...fast });
    await assert.rejects(bad.tipHeight(), (e: unknown) => e instanceof EsploraError && e.status === 400 && bad.stats.requests === 1);
    const down = new EsploraClient({ baseUrls: ["https://a.invalid/api"], fetch: async () => { throw new Error("ECONNRESET"); }, ...fast, retries: 2 });
    await assert.rejects(down.tipHeight(), /failed: ECONNRESET/);
    assert.equal(down.stats.requests, 3);
  });

  test("requests are paced", async () => {
    const client = new EsploraClient({ baseUrls: ["https://a.invalid/api"], fetch: async () => new Response("1"), requestsPerSecond: 10, burst: 1 });
    const started = Date.now();
    for (let i = 0; i < 4; i++) await client.tipHeight();
    assert.ok(Date.now() - started >= 250, `4 requests at 10/s took ${Date.now() - started} ms`);
  });
});

