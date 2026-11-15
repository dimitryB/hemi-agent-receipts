import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A JSON-RPC proxy that injects the failures Hemi's RPCs are expected to produce
 * (docs/DECISIONS.md: June 2026 outage, node rewrite, ~300 req/min public limit).
 *
 * Modes:
 *  - http503 / http429 / http502: answer with that status and no JSON-RPC body
 *  - reset: destroy the socket without answering
 *  - timeout: hold the request for `stallMs`, then destroy the socket (a stalled RPC)
 *  - rpc-internal: HTTP 200 with JSON-RPC error -32603
 *  - rpc-limit: HTTP 200 with JSON-RPC error -32005 (rate limited)
 *  - drop-response: FORWARD the request upstream, then destroy the socket before answering.
 *    The call took effect but the client never learns it; eth_sendRawTransaction under this
 *    mode is the "was my tx sent?" case a relayer must survive. Off unless listed.
 *
 * Injection is decided per HTTP request by a seeded PRNG, so a failing run can be replayed.
 */
export type FlakyMode = "http503" | "http429" | "http502" | "reset" | "timeout" | "rpc-internal" | "rpc-limit" | "drop-response";

export const DEFAULT_MODES: FlakyMode[] = ["http503", "http429", "http502", "reset", "timeout", "rpc-internal", "rpc-limit"];

export interface FlakyRpcOptions {
  upstream: string;
  /** Probability (0..1) that a request is failed. Default 0.3. */
  failureRate?: number;
  modes?: FlakyMode[];
  /** How long a "timeout" request is held before its socket is destroyed. Default 2,000 ms. */
  stallMs?: number;
  /** Extra latency added to every forwarded request, in ms. Default 0. */
  latencyMs?: number;
  seed?: number;
  /** Never inject on these methods (e.g. to keep a test's setup deterministic). */
  exemptMethods?: string[];
}

export interface FlakyRpc {
  url: string;
  stats: { requests: number; forwarded: number; injected: Partial<Record<FlakyMode, number>> };
  setFailureRate(rate: number): void;
  stop(): Promise<void>;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function methodsOf(body: string): string[] {
  try {
    const parsed = JSON.parse(body);
    return (Array.isArray(parsed) ? parsed : [parsed]).map((r: { method?: string }) => String(r.method));
  } catch {
    return [];
  }
}

function rpcError(body: string, code: number, message: string): string {
  try {
    const parsed = JSON.parse(body);
    const one = (r: { id?: unknown }) => ({ jsonrpc: "2.0", id: r.id ?? null, error: { code, message } });
    return JSON.stringify(Array.isArray(parsed) ? parsed.map(one) : one(parsed));
  } catch {
    return JSON.stringify({ jsonrpc: "2.0", id: null, error: { code, message } });
  }
}

export async function startFlakyRpc(options: FlakyRpcOptions): Promise<FlakyRpc> {
  let failureRate = options.failureRate ?? 0.3;
  const modes = options.modes ?? DEFAULT_MODES;
  const stallMs = options.stallMs ?? 2_000;
  const random = mulberry32(options.seed ?? 42);
  const exempt = new Set(options.exemptMethods ?? []);
  const stats: FlakyRpc["stats"] = { requests: 0, forwarded: 0, injected: {} };
  const stalled = new Set<NodeJS.Timeout>();

  async function forward(body: string): Promise<{ status: number; text: string }> {
    if (options.latencyMs) await new Promise((r) => setTimeout(r, options.latencyMs));
    const res = await fetch(options.upstream, { method: "POST", headers: { "content-type": "application/json" }, body });
    stats.forwarded++;
    return { status: res.status, text: await res.text() };
  }

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const body = await readBody(req);
    stats.requests++;
    const methods = methodsOf(body);
    const inject = !methods.some((m) => exempt.has(m)) && random() < failureRate;
    const mode = inject ? modes[Math.floor(random() * modes.length)]! : undefined;
    if (mode) stats.injected[mode] = (stats.injected[mode] ?? 0) + 1;

    try {
      switch (mode) {
        case "http503":
        case "http429":
        case "http502":
          res.writeHead(Number(mode.slice(4)), { "content-type": "text/plain" }).end(`injected ${mode}`);
          return;
        case "reset":
          req.socket.destroy();
          return;
        case "timeout": {
          const timer = setTimeout(() => {
            stalled.delete(timer);
            req.socket.destroy();
          }, stallMs);
          stalled.add(timer);
          return;
        }
        case "rpc-internal":
          res.writeHead(200, { "content-type": "application/json" }).end(rpcError(body, -32603, "injected internal error"));
          return;
        case "rpc-limit":
          res.writeHead(200, { "content-type": "application/json" }).end(rpcError(body, -32005, "injected rate limit"));
          return;
        case "drop-response":
          await forward(body);
          req.socket.destroy();
          return;
        default: {
          const upstream = await forward(body);
          res.writeHead(upstream.status, { "content-type": "application/json" }).end(upstream.text);
        }
      }
    } catch (error) {
      res.writeHead(502, { "content-type": "text/plain" }).end(`proxy error: ${(error as Error).message}`);
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    stats,
    setFailureRate(rate: number) {
      failureRate = rate;
    },
    async stop() {
      for (const timer of stalled) clearTimeout(timer);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
