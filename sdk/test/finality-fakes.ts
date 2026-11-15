/**
 * Deterministic stand-ins for the Hemi RPC and Esplora, served from fixtures recorded once
 * (read-only) under test/fixtures/: Hemi mainnet/testnet blocks and blockstream.info answers.
 */
import { readFileSync } from "node:fs";
import { createPublicClient, custom, hexToBytes, type Hex, type PublicClient } from "viem";
import { chainFor, type EsploraTx, type FetchLike } from "../src/index.js";

const load = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
export const MAINNET_BLOCKS: Record<string, RpcBlock> = load("hemi-mainnet-blocks.json");
export const TESTNET: { latest: number; blocks: Record<string, RpcBlock> } = load("hemi-testnet-blocks.json");
export const ESPLORA: {
  tip: number;
  coinbaseTxid: string;
  tx: Record<string, EsploraTx>;
  txHex: Record<string, string>;
  blockHeight: Record<string, string>;
  addressPages: { after: string | null; txs: EsploraTx[] }[];
} = load("esplora-mainnet.json");

export const POP_TXID = "d4ed6ec2eaa89b78906efc54c3dd309761bb30ca8a38b6477951033957a6845e";
export const MINER = "17Fv7httdZvqMubbvMkQ9KLPiTSPobxAqF";

export interface RpcBlock {
  number: Hex;
  hash: Hex;
  parentHash: Hex;
  stateRoot: Hex;
  timestamp: Hex;
  transactions: ({ hash: Hex; from: Hex; to: Hex | null; input: Hex; type: Hex } | Hex)[];
  [key: string]: unknown;
}

/** A PublicClient answering eth_getBlockByNumber / eth_blockNumber / eth_chainId from fixture blocks. */
export function fakeHemi(options: { chainId: number; blocks: Record<string, RpcBlock>; latest: number }): PublicClient & { calls: string[] } {
  const calls: string[] = [];
  const client = createPublicClient({
    chain: chainFor(options.chainId, ["http://fixture.invalid"]),
    cacheTime: 0,
    transport: custom({
      async request({ method, params }: { method: string; params?: unknown[] }) {
        calls.push(`${method}${params?.length ? ` ${String(params[0])}` : ""}`);
        if (method === "eth_chainId") return `0x${options.chainId.toString(16)}`;
        if (method === "eth_blockNumber") return `0x${options.latest.toString(16)}`;
        if (method === "eth_getBlockByNumber") {
          const n = Number(BigInt(params![0] as string));
          const block = options.blocks[String(n)];
          if (!block) throw new Error(`fixture has no block ${n}`);
          if (params![1] === false) return { ...block, transactions: block.transactions.map((t) => (typeof t === "string" ? t : t.hash)) };
          if (block.transactions.some((t) => typeof t === "string")) throw new Error(`fixture block ${n} was recorded without transactions`);
          return block;
        }
        throw new Error(`fake Hemi RPC: ${method} not supported`);
      },
    }),
  }) as unknown as PublicClient & { calls: string[] };
  client.calls = calls;
  return client;
}

/** Fake Esplora: routes paths to the given data; anything else is a 404. Records every path. */
export function fakeEsplora(data: {
  tip: number;
  pages?: Record<string, { after: string | null; txs: EsploraTx[] }[]>;
  blockHeight?: Record<number, string>;
  tx?: Record<string, EsploraTx>;
  raw?: Record<string, Uint8Array>;
  blockTimes?: (height: number) => number;
}): FetchLike & { paths: string[] } {
  const paths: string[] = [];
  const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
  const fn = (async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const path = url.pathname.replace(/^\/api/, "");
    paths.push(path);
    let m: RegExpExecArray | null;
    if (path === "/blocks/tip/height") return new Response(String(data.tip));
    if ((m = /^\/address\/([^/]+)\/txs(?:\/chain\/([0-9a-f]+))?$/.exec(path))) {
      const page = data.pages?.[m[1]!]?.find((p) => p.after === (m![2] ?? null));
      return json(page?.txs ?? []);
    }
    if ((m = /^\/block-height\/(\d+)$/.exec(path))) {
      const hash = data.blockHeight?.[Number(m[1])];
      return hash ? new Response(hash) : new Response("Block not found", { status: 404 });
    }
    if ((m = /^\/tx\/([0-9a-f]{64})$/.exec(path))) {
      const tx = data.tx?.[m[1]!];
      return tx ? json(tx) : new Response("Transaction not found", { status: 404 });
    }
    if ((m = /^\/block\/([0-9a-f]{64})\/raw$/.exec(path))) {
      const raw = data.raw?.[m[1]!];
      return raw ? new Response(raw) : new Response("Block not found", { status: 404 });
    }
    if ((m = /^\/blocks\/(\d+)$/.exec(path)) && data.blockTimes) {
      const top = Math.min(Number(m[1]), data.tip);
      return json(Array.from({ length: 10 }, (_, i) => top - i).filter((h) => h >= 0).map((h) => ({ id: data.blockHeight?.[h] ?? `${h}`.padStart(64, "0"), height: h, timestamp: data.blockTimes!(h) })));
    }
    return new Response("not found", { status: 404 });
  }) as FetchLike & { paths: string[] };
  fn.paths = paths;
  return fn;
}

/** A raw Bitcoin block (80-byte header with `time`, then the given raw transactions). */
export function rawBlock(time: number, txHexes: string[]): Uint8Array {
  const header = new Uint8Array(80);
  new DataView(header.buffer).setUint32(68, time, true);
  const txs = txHexes.map((h) => hexToBytes(`0x${h}`));
  const total = 80 + 1 + txs.reduce((a, t) => a + t.length, 0);
  const out = new Uint8Array(total);
  out.set(header, 0);
  out[80] = txs.length;
  let i = 81;
  for (const t of txs) {
    out.set(t, i);
    i += t.length;
  }
  return out;
}

/** An Esplora-shaped tx carrying one PoP output. */
export function popTx(txid: string, script: string, status: EsploraTx["status"]): EsploraTx {
  return { txid, status, vout: [{ scriptpubkey: "76a91444a2eab624146b6f8185a6af19645460e9f5f9a488ac", scriptpubkey_type: "p2pkh", value: 1000 }, { scriptpubkey: script, scriptpubkey_type: "op_return", value: 0 }] };
}
