import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { ANVIL_KEYS, deployRegistry, ROLE } from "@hemi-receipts/e2e/lib";
import type { RunningService } from "../src/service.js";
import { ConfigError, loadConfig } from "../src/config.js";
import { StartupError } from "../src/chain.js";
import { accounts, setupChain, startTestService, tempDbPath, testEnv, type TestChain } from "./helpers.js";

const ENTRY = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const SERVICE_DIR = fileURLToPath(new URL("..", import.meta.url));

describe("startup refuses a misconfigured service", () => {
  let chain: TestChain;
  let db: ReturnType<typeof tempDbPath>;

  before(async () => {
    chain = await setupChain();
    db = tempDbPath();
  });

  after(async () => {
    await chain?.stop();
    db?.cleanup();
  });

  it("refuses a SERVICE_PRIVATE_KEY that is not the registry's serviceSigner, naming both addresses", async () => {
    await assert.rejects(
      startTestService(testEnv(chain, db.path, { SERVICE_PRIVATE_KEY: ANVIL_KEYS[ROLE.stranger] })),
      (error: Error) => {
        assert.ok(error instanceof StartupError, error.message);
        assert.match(error.message, /serviceSigner mismatch/);
        assert.ok(error.message.includes(accounts.service.address), "names the registry's signer");
        assert.ok(error.message.includes(accounts.stranger.address), "names the configured key's address");
        return true;
      },
    );
  });

  it("refuses an RPC whose chain id differs from CHAIN_ID", async () => {
    await assert.rejects(startTestService(testEnv(chain, db.path, { CHAIN_ID: "743111" })), (error: Error) => {
      assert.ok(error instanceof StartupError, error.message);
      assert.match(error.message, /chain id mismatch: the RPC \(.*\) reports chain 31337, but CHAIN_ID is 743111/);
      return true;
    });
  });

  it("refuses a REGISTRY_ADDRESS with no contract", async () => {
    await assert.rejects(startTestService(testEnv(chain, db.path, { REGISTRY_ADDRESS: accounts.stranger.address })), /no contract at REGISTRY_ADDRESS/);
  });

  it("refuses a database that belongs to another registry", async () => {
    const service = await startTestService(testEnv(chain, db.path));
    await service.stop();
    // A second registry on the same chain (a fresh anvil would deploy at the same
    // deterministic address, which is the same registry as far as the binding can tell).
    const { registry: other } = await deployRegistry({
      rpcUrl: chain.anvil.url,
      chainId: chain.anvil.chainId,
      deployerKey: ANVIL_KEYS[ROLE.owner]!,
      owner: accounts.owner.address,
      serviceSigner: accounts.service.address,
    });
    assert.notEqual(other.toLowerCase(), chain.registry.toLowerCase());
    let started: RunningService | undefined;
    try {
      await assert.rejects(
        startTestService(testEnv(chain, db.path, { REGISTRY_ADDRESS: other })).then((s) => (started = s)),
        /belongs to registry .* use another DB_PATH/,
      );
    } finally {
      await started?.stop();
    }
  });

  it("reports every configuration problem at once, without echoing secrets", () => {
    assert.throws(
      () => loadConfig({ SERVICE_PRIVATE_KEY: "0xnot-a-key-SECRET", DEV_FREE: "0", BATCH_MAX_SIZE: "70000", HEMI_RPC_URLS: "ftp://x" }),
      (error: Error) => {
        assert.ok(error instanceof ConfigError);
        const text = error.message;
        assert.match(text, /REGISTRY_ADDRESS is required/);
        assert.match(text, /SERVICE_PRIVATE_KEY must be a 0x-prefixed 32-byte hex private key \(value not shown\)/);
        assert.match(text, /PAY_TO is required/);
        assert.match(text, /BATCH_MAX_SIZE must be an integer from 1 to 65536/);
        assert.match(text, /HEMI_RPC_URLS contains "ftp:\/\/x"/);
        assert.ok(!text.includes("SECRET"), "secrets are never echoed");
        return true;
      },
    );
    const defaults = loadConfig({ REGISTRY_ADDRESS: chain.registry, SERVICE_PRIVATE_KEY: ANVIL_KEYS[ROLE.service], DEV_FREE: "1" });
    assert.equal(defaults.chainId, 743111);
    assert.deepEqual(defaults.rpcUrls, ["https://testnet.rpc.hemi.network/rpc"]);
    assert.equal(defaults.relayerPrivateKey, defaults.servicePrivateKey, "RELAYER_PRIVATE_KEY defaults to SERVICE_PRIVATE_KEY");
    assert.equal(defaults.port, 8787);
    assert.equal(defaults.batchMaxSize, 64);
    assert.equal(defaults.batchMaxWaitMs, 60_000);
    assert.equal(defaults.hemiConfirmations, 10);
    assert.equal(defaults.pollIntervalMs, 15_000);
    assert.equal(defaults.priceBatch, "1000");
    assert.equal(defaults.priceDirect, "10000");
    assert.equal(defaults.paymentAsset?.address, "0xD47971C7F5B1067d25cd45d30b2c9eb60de96443");
    const mainnet = loadConfig({ CHAIN_ID: "43111", REGISTRY_ADDRESS: chain.registry, SERVICE_PRIVATE_KEY: ANVIL_KEYS[ROLE.service], PAY_TO: accounts.owner.address });
    assert.deepEqual(mainnet.paymentAsset, {
      address: "0xad11a8BEb98bbf61dbb1aa0F6d6F2ECD87b35afA",
      transferMethod: "eip3009",
      eip712: { name: "Bridged USDC (Stargate)", version: "2" },
    });
  });

  it("the entry point exits 1 with the reason", async () => {
    const child = spawn(process.execPath, ["--import", "tsx", ENTRY], {
      cwd: SERVICE_DIR,
      env: { ...process.env, ...testEnv(chain, db.path, { SERVICE_PRIVATE_KEY: ANVIL_KEYS[ROLE.stranger], LOG_LEVEL: "info" }) } as NodeJS.ProcessEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout!.on("data", (chunk) => (output += String(chunk)));
    child.stderr!.on("data", (chunk) => (output += String(chunk)));
    const [code] = (await once(child, "exit")) as [number | null];
    assert.equal(code, 1);
    assert.match(output, /refusing to start: serviceSigner mismatch/);
  });
});
