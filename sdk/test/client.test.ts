import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { ANVIL_KEYS, ROLE, deployRegistry, startAnvil, startFlakyRpc, type Anvil } from "@hemi-receipts/e2e/lib";
import { privateKeyToAccount } from "viem/accounts";
import { createHemiPublicClient, receiptRegistryAbi, TokenBucket, withRetry } from "../src/index.js";

let anvil: Anvil;
before(async () => {
  anvil = await startAnvil({ chainId: 743_111 });
});
after(async () => {
  await anvil?.stop();
});

describe("createHemiPublicClient through the flaky proxy", () => {
  test("retries through injected failures (failureRate 0.3, default modes)", async () => {
    const flaky = await startFlakyRpc({ upstream: anvil.url, failureRate: 0.3, seed: 11 });
    try {
      const client = createHemiPublicClient({ chainId: 743_111, rpcUrls: [flaky.url], requestsPerSecond: 200, burst: 50, retryDelayMs: 10, retryCount: 12, timeoutMs: 5_000 });
      // Sequential: viem dedupes identical concurrent requests, and every call should reach the proxy.
      for (let i = 0; i < 40; i++) assert.equal(await client.getChainId(), 743_111);
      for (let i = 0; i < 10; i++) assert.ok((await client.getBalance({ address: privateKeyToAccount(ANVIL_KEYS[i % 6]!).address })) > 0n);
      const injected = Object.values(flaky.stats.injected).reduce((a, b) => a + (b ?? 0), 0);
      assert.ok(injected >= 8, `expected injected failures, stats ${JSON.stringify(flaky.stats)}`);
      assert.ok(flaky.stats.requests > 50, `requests ${flaky.stats.requests}`);
    } finally {
      await flaky.stop();
    }
  });

  test("a revert is an answer, not a failure: it is not retried", async () => {
    const owner = privateKeyToAccount(ANVIL_KEYS[ROLE.owner]!);
    const service = privateKeyToAccount(ANVIL_KEYS[ROLE.service]!);
    const { registry } = await deployRegistry({ rpcUrl: anvil.url, chainId: 743_111, deployerKey: ANVIL_KEYS[ROLE.owner]!, owner: owner.address, serviceSigner: service.address });
    const counting = await startFlakyRpc({ upstream: anvil.url, failureRate: 0 });
    try {
      const client = createHemiPublicClient({ chainId: 743_111, rpcUrls: [counting.url], retryDelayMs: 10 });
      await assert.rejects(client.readContract({ address: registry, abi: receiptRegistryAbi, functionName: "getBatch", args: [42n] }), /UnknownBatch/);
      assert.equal(counting.stats.requests, 1);
    } finally {
      await counting.stop();
    }
  });

  test("falls back to the next RPC when the first is down", async () => {
    const client = createHemiPublicClient({ chainId: 743_111, rpcUrls: ["http://127.0.0.1:1", anvil.url], retryDelayMs: 10, timeoutMs: 1_000 });
    assert.equal(await client.getChainId(), 743_111);
  });

  test("gives up after retryCount on a dead RPC", async () => {
    const client = createHemiPublicClient({ chainId: 743_111, rpcUrls: ["http://127.0.0.1:1"], retryCount: 2, retryDelayMs: 5, timeoutMs: 500 });
    await assert.rejects(client.getBlockNumber());
  });
});

describe("rate limiting", () => {
  test("TokenBucket allows a burst, then paces at the sustained rate, in FIFO order", async () => {
    const bucket = new TokenBucket(20, 3);
    const started = Date.now();
    const order: number[] = [];
    await Promise.all(Array.from({ length: 13 }, (_, i) => bucket.take().then(() => order.push(i))));
    const elapsed = Date.now() - started;
    // 3 immediately, then 10 at 20/s: about 500 ms
    assert.ok(elapsed >= 450, `elapsed ${elapsed} ms`);
    assert.ok(elapsed < 1_500, `elapsed ${elapsed} ms`);
    assert.deepEqual(order, [...order].sort((a, b) => a - b));
  });

  test("the client paces RPC requests (requestsPerSecond, burst)", async () => {
    const counting = await startFlakyRpc({ upstream: anvil.url, failureRate: 0 });
    try {
      const client = createHemiPublicClient({ chainId: 743_111, rpcUrls: [counting.url], requestsPerSecond: 10, burst: 2 });
      const started = Date.now();
      for (let i = 0; i < 8; i++) await client.getBlockNumber({ cacheTime: 0 });
      const elapsed = Date.now() - started;
      assert.equal(counting.stats.requests, 8);
      // 2 immediately, 6 more at 10/s: at least ~600 ms
      assert.ok(elapsed >= 550, `8 requests at 10/s with burst 2 took only ${elapsed} ms`);
    } finally {
      await counting.stop();
    }
  });

  test("retries and fallbacks each take a token: a failing RPC is not hammered", async () => {
    // An RPC that always answers 500. viem retries the whole URL list retryCount times; every
    // attempt is an HTTP request and must be paced. One token per logical call would let a
    // single getBlockNumber fire all four requests within a few milliseconds.
    const hits: number[] = [];
    const server = createServer((_req, res) => {
      hits.push(Date.now());
      res.writeHead(500, { "content-type": "application/json" }).end('{"error":"boom"}');
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const client = createHemiPublicClient({ chainId: 743_111, rpcUrls: [url, url], retryCount: 1, retryDelayMs: 1, requestsPerSecond: 20, burst: 1, timeoutMs: 2_000 });
      await assert.rejects(client.getBlockNumber({ cacheTime: 0 }));
      // 2 URLs × (1 + 1 retry) = 4 attempts: one at once, then one every 50 ms
      assert.equal(hits.length, 4, `attempts ${hits.length}`);
      const gaps = hits.slice(1).map((t, i) => t - hits[i]!);
      assert.ok(Math.min(...gaps) >= 35, `attempts were ${gaps.join(", ")} ms apart; each must take a token (50 ms at 20/s)`);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  test("the default rate stays under the public RPC's ~300 requests a minute", async () => {
    const counting = await startFlakyRpc({ upstream: anvil.url, failureRate: 0 });
    try {
      const client = createHemiPublicClient({ chainId: 743_111, rpcUrls: [counting.url] });
      const started = Date.now();
      for (let i = 0; i < 12; i++) await client.getBlockNumber({ cacheTime: 0 });
      const elapsed = Date.now() - started;
      // default burst 8, then 4/s: 12 requests need >= ~1 s; 300/min would be 5/s
      assert.ok(elapsed >= 900, `elapsed ${elapsed} ms`);
    } finally {
      await counting.stop();
    }
  });
});

describe("withRetry", () => {
  test("retries until success", async () => {
    let calls = 0;
    const value = await withRetry(async (attempt) => {
      calls++;
      if (attempt < 3) throw new Error("transient");
      return "ok";
    }, { baseDelayMs: 1 });
    assert.equal(value, "ok");
    assert.equal(calls, 4);
  });

  test("stops when shouldRetry says no, and after `retries`", async () => {
    let calls = 0;
    await assert.rejects(withRetry(async () => { calls++; throw new Error("fatal"); }, { baseDelayMs: 1, shouldRetry: () => false }), /fatal/);
    assert.equal(calls, 1);
    calls = 0;
    await assert.rejects(withRetry(async () => { calls++; throw new Error("always"); }, { retries: 2, baseDelayMs: 1 }), /always/);
    assert.equal(calls, 3);
  });
});
