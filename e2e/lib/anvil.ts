import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import type { Hex } from "viem";

/** anvil's default dev keys ("test test … junk"). Local chains only. */
export const ANVIL_KEYS: Hex[] = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
  "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
];

/** Conventional roles in tests: index into ANVIL_KEYS. */
export const ROLE = { owner: 0, service: 1, relayer: 2, agent: 3, principal: 4, stranger: 5 } as const;

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => (typeof address === "object" && address ? resolve(address.port) : reject(new Error("no port"))));
    });
  });
}

export interface Anvil {
  url: string;
  port: number;
  chainId: number;
  process: ChildProcess;
  stop(): Promise<void>;
}

/**
 * Starts a local anvil. `blockTime` (seconds) makes it mine on an interval instead of on
 * every transaction; tests of confirmations want that, tests of logic do not.
 */
export async function startAnvil(options: { chainId?: number; blockTime?: number; port?: number } = {}): Promise<Anvil> {
  const port = options.port ?? (await freePort());
  const chainId = options.chainId ?? 31337;
  const args = ["--port", String(port), "--chain-id", String(chainId), "--silent"];
  if (options.blockTime) args.push("--block-time", String(options.blockTime));
  const child = spawn("anvil", args, { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr?.on("data", (chunk) => (stderr += String(chunk)));
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 15_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`anvil exited (${child.exitCode}): ${stderr}`);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      });
      if (res.ok) break;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error(`anvil did not start on ${url}: ${stderr}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  return {
    url,
    port,
    chainId,
    process: child,
    async stop() {
      if (child.exitCode !== null) return;
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    },
  };
}

/** Mines `count` blocks on anvil immediately. */
export async function mine(url: string, count = 1): Promise<void> {
  await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "anvil_mine", params: [`0x${count.toString(16)}`] }),
  });
}
