/** resolveStatus stage rules on anvil: safe head, confirmation count, reorg, and verified-only Bitcoin stages. */
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { createPublicClient, custom, http, type PublicClient } from "viem";
import { mine, startAnvil, type Anvil } from "@hemi-receipts/e2e/lib";
import { chainFor, resolveStatus, type BtcFinality, type FinalityReader } from "../src/index.js";

let hemiLike: Anvil; // chain id 743111: resolveStatus applies the safe-head rule (anvil: safe = latest − 32)
let local: Anvil; // chain id 31337: count rule only
let client: PublicClient;
let localClient: PublicClient;

const clientFor = (a: Anvil) => createPublicClient({ chain: chainFor(a.chainId, [a.url]), transport: http(a.url), cacheTime: 0 }) as PublicClient;
const fixed = (btc: BtcFinality): FinalityReader => ({ read: async () => btc });

before(async () => {
  hemiLike = await startAnvil({ chainId: 743_111 });
  local = await startAnvil();
  client = clientFor(hemiLike);
  localClient = clientFor(local);
  await mine(hemiLike.url, 5);
  await mine(local.url, 5);
});
after(async () => {
  await hemiLike?.stop();
  await local?.stop();
});

describe("hemi-included → hemi-confirmed", () => {
  test("on a Hemi chain id the safe head is read: above it the block stays hemi-included", async () => {
    const B = await client.getBlockNumber();
    await mine(hemiLike.url, 5);
    const s = await resolveStatus({ client, blockNumber: B, confirmations: 3 });
    assert.equal(s.stage, "hemi-included");
    assert.equal(s.hemi?.confirmations, 6);
    assert.equal(s.hemi?.safeBlock, Number(B) + 5 - 32 < 0 ? 0 : Number(B) + 5 - 32);
    assert.ok(s.notes?.some((n) => /waiting for the safe head: block \d+ is above safe block \d+/.test(n)), JSON.stringify(s.notes));
    await mine(hemiLike.url, 40);
    const c = await resolveStatus({ client, blockNumber: B, confirmations: 3 });
    assert.equal(c.stage, "hemi-confirmed");
    assert.ok(c.hemi!.safeBlock! >= Number(B));
    assert.equal(c.estimated, false);
    assert.equal(c.btc?.source, "unavailable");
  });

  test("confirmations are still required when the block is at or below the safe head", async () => {
    const latest = await client.getBlockNumber();
    const s = await resolveStatus({ client, blockNumber: latest - 1n, confirmations: 3, safeBlock: latest });
    assert.equal(s.stage, "hemi-included");
    assert.equal(s.hemi?.safeBlock, Number(latest));
  });

  test("an explicit safeBlock is used as given; null means the count rule only", async () => {
    const latest = await client.getBlockNumber();
    const B = latest - 10n;
    assert.equal((await resolveStatus({ client, blockNumber: B, confirmations: 3, safeBlock: B - 1n })).stage, "hemi-included");
    assert.equal((await resolveStatus({ client, blockNumber: B, confirmations: 3, safeBlock: B })).stage, "hemi-confirmed");
    const countOnly = await resolveStatus({ client, blockNumber: latest - 3n, confirmations: 3, safeBlock: null });
    assert.equal(countOnly.stage, "hemi-confirmed");
    assert.equal(countOnly.hemi?.safeBlock, undefined);
  });

  test("on a non-Hemi chain (local anvil) only the count rule applies", async () => {
    const latest = await localClient.getBlockNumber();
    const s = await resolveStatus({ client: localClient, blockNumber: latest - 2n, confirmations: 3 });
    assert.equal(s.stage, "hemi-confirmed");
    assert.equal(s.hemi?.safeBlock, undefined);
    assert.equal(s.notes, undefined);
    assert.equal((await resolveStatus({ client: localClient, blockNumber: latest - 1n, confirmations: 3 })).stage, "hemi-included");
  });

  test("an RPC that cannot serve the safe head falls back to the count rule, with a note", async () => {
    const noSafe = createPublicClient({
      chain: chainFor(743_111, [hemiLike.url]),
      cacheTime: 0,
      transport: custom({
        async request({ method, params }: { method: string; params?: unknown[] }) {
          if (method === "eth_getBlockByNumber" && params?.[0] === "safe") throw new Error("unknown block tag safe");
          return client.request({ method, params } as never);
        },
      }),
    }) as PublicClient;
    const latest = await client.getBlockNumber();
    const s = await resolveStatus({ client: noSafe, blockNumber: latest - 4n, confirmations: 3 });
    assert.equal(s.stage, "hemi-confirmed");
    assert.ok(s.notes?.includes("the RPC did not serve the safe head; hemi-confirmed uses the confirmation count only"), JSON.stringify(s.notes));
  });

  test("a reorged-out anchoring block is pending again", async () => {
    const latest = await client.getBlockNumber();
    const B = latest - 50n;
    const block = await client.getBlock({ blockNumber: B });
    assert.equal((await resolveStatus({ client, blockNumber: B, confirmations: 3, anchorBlockHash: block.hash })).stage, "hemi-confirmed");
    const wrong = `0x${"ab".repeat(32)}` as const;
    const s = await resolveStatus({ client, blockNumber: B, confirmations: 3, anchorBlockHash: wrong });
    assert.equal(s.stage, "pending");
    assert.match(s.notes![0]!, new RegExp(`anchoring block was reorged out: block ${B} is now ${block.hash}, the anchor was in ${wrong}`));
  });
});

describe("Bitcoin stages come only from verified data", () => {
  const confirmed = async () => (await client.getBlockNumber()) - 40n;

  test("an estimate never advances the stage, even when its times are long past", async () => {
    const btc: BtcFinality = { source: "estimate", popLive: true, estimatedPublishedAt: 1, estimatedFinalAt: 2, detail: "expected" };
    const s = await resolveStatus({ client, blockNumber: await confirmed(), confirmations: 3, finality: fixed(btc) });
    assert.equal(s.stage, "hemi-confirmed");
    assert.equal(s.estimated, false);
    assert.equal(s.btc?.estimatedFinalAt, 2, "the expected-by times are still reported");
  });

  test("unverified data with heights does not advance either", async () => {
    const s = await resolveStatus({ client, blockNumber: await confirmed(), confirmations: 3, finality: fixed({ source: "estimate", publishedAtBtcHeight: 1, btcConfirmations: 20 }) });
    assert.equal(s.stage, "hemi-confirmed");
  });

  test("source bitcoin (or bfg): published below 9 confirmations, final at 9", async () => {
    const B = await confirmed();
    const published = await resolveStatus({ client, blockNumber: B, confirmations: 3, finality: fixed({ source: "bitcoin", publishedAtBtcHeight: 973_746, btcConfirmations: 8 }) });
    assert.equal(published.stage, "btc-published");
    const final = await resolveStatus({ client, blockNumber: B, confirmations: 3, finality: fixed({ source: "bitcoin", publishedAtBtcHeight: 973_746, btcConfirmations: 9 }) });
    assert.equal(final.stage, "btc-final");
    assert.equal(final.estimated, false);
    const bfg = await resolveStatus({ client, blockNumber: B, confirmations: 3, finality: fixed({ source: "bfg", publishedAtBtcHeight: 1, btcConfirmations: 12 }) });
    assert.equal(bfg.stage, "btc-final");
  });

  test("the reader gets the latest block; a reader that throws leaves hemi-confirmed with source unavailable", async () => {
    let seen: bigint | undefined;
    const spy: FinalityReader = { read: async (input) => ((seen = input.latestBlock), { source: "unavailable" }) };
    await resolveStatus({ client, blockNumber: await confirmed(), confirmations: 3, finality: spy, latestBlock: 123_456n, safeBlock: null });
    assert.equal(seen, 123_456n);
    const failing: FinalityReader = { read: async () => { throw new Error("esplora down"); } };
    const s = await resolveStatus({ client, blockNumber: await confirmed(), confirmations: 3, finality: failing });
    assert.equal(s.stage, "hemi-confirmed");
    assert.equal(s.btc?.source, "unavailable");
    assert.equal(s.btc?.detail, "Bitcoin finality could not be read: esplora down");
  });
});
