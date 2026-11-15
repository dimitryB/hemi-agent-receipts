/**
 * Live, read-only checks against Hemi's public RPCs and blockstream.info / mempool.space.
 * Skipped unless LIVE_HEMI=1. They send no transactions.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createHemiPublicClient, defaultFinalityReader, resolveStatus } from "../src/index.js";

const live = process.env.LIVE_HEMI === "1";
const log = (label: string, value: unknown) => console.log(`# ${label}: ${JSON.stringify(value)}`);

describe("live: Bitcoin finality from public data", { skip: !live && "set LIVE_HEMI=1 to run" }, () => {
  test("mainnet block 5620209: keystone 5620225 in BTC 973746 by d4ed6ec2…845e", { timeout: 300_000 }, async () => {
    const client = createHemiPublicClient({ chainId: 43_111 });
    const s = await resolveStatus({ client, blockNumber: 5_620_209n, finality: defaultFinalityReader(43_111) });
    log("5620209", s);
    assert.equal(s.btc?.source, "bitcoin");
    assert.equal(s.btc?.coveringKeystone, 5_620_225);
    assert.equal(s.btc?.viaKeystone, 5_620_225);
    assert.equal(s.btc?.inherited, false);
    assert.equal(s.btc?.publishedAtBtcHeight, 973_746);
    assert.equal(s.btc?.popTxid, "d4ed6ec2eaa89b78906efc54c3dd309761bb30ca8a38b6477951033957a6845e");
    assert.equal(s.stage, s.btc!.btcConfirmations! >= 9 ? "btc-final" : "btc-published");
    assert.equal(s.estimated, false);
  });

  test("mainnet block 5619605: keystone 5619625 inherits keystone 5619825's publication in BTC 973739", { timeout: 300_000 }, async () => {
    const client = createHemiPublicClient({ chainId: 43_111 });
    const s = await resolveStatus({ client, blockNumber: 5_619_605n, finality: defaultFinalityReader(43_111) });
    log("5619605", s);
    assert.equal(s.stage, "btc-final");
    assert.equal(s.btc?.coveringKeystone, 5_619_625);
    assert.equal(s.btc?.viaKeystone, 5_619_825);
    assert.equal(s.btc?.inherited, true);
    assert.equal(s.btc?.publishedAtBtcHeight, 973_739);
  });

  test("a recent testnet block: hemi-confirmed, Bitcoin unavailable (no PoP activity)", { timeout: 120_000 }, async () => {
    const client = createHemiPublicClient({ chainId: 743_111 });
    const latest = await client.getBlockNumber();
    const s = await resolveStatus({ client, blockNumber: latest - 100n, finality: defaultFinalityReader(743_111) });
    log(`testnet ${latest - 100n}`, s);
    assert.equal(s.stage, "hemi-confirmed");
    assert.ok(s.hemi?.safeBlock !== undefined && s.hemi.safeBlock >= Number(latest - 100n));
    assert.equal(s.btc?.source, "unavailable");
    assert.match(s.btc!.detail!, /^no PoP activity: no PoP payout in \d+ keystone blocks? sampled over the last /);
  });
});
