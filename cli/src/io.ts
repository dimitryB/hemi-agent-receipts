import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { FetchLike } from "@hemi-receipts/sdk";

/** Exit codes: 0 success / valid, 1 the operation failed / invalid, 2 usage or runtime error. */
export const EXIT = { ok: 0, failed: 1, usage: 2 } as const;

/** Everything a command touches outside itself, so tests can run commands in-process. */
export interface Io {
  out(text: string): void;
  err(text: string): void;
  env: Record<string, string | undefined>;
  fetch: FetchLike;
  cwd: string;
}

export function defaultIo(): Io {
  return {
    out: (text) => process.stdout.write(text.endsWith("\n") ? text : `${text}\n`),
    err: (text) => process.stderr.write(text.endsWith("\n") ? text : `${text}\n`),
    env: process.env,
    fetch: globalThis.fetch,
    cwd: process.cwd(),
  };
}

/** Bad arguments or environment: exit 2, with the command's usage hint. */
export class UsageError extends Error {
  override name = "UsageError";
}

/** The operation ran and failed (rejected, invalid, not found): exit 1. */
export class Failure extends Error {
  override name = "Failure";
}

export const DEFAULT_SERVICE_URL = "http://localhost:8787";

export function serviceUrl(flag: string | undefined, io: Io): string {
  const url = flag ?? io.env.RECEIPTS_SERVICE_URL ?? DEFAULT_SERVICE_URL;
  if (!/^https?:\/\//.test(url)) throw new UsageError(`--service must be an http(s) URL, got ${JSON.stringify(url)}`);
  return url;
}

export async function readText(path: string, io: Io): Promise<string> {
  try {
    return await readFile(resolve(io.cwd, path), "utf8");
  } catch (error) {
    throw new UsageError(`cannot read ${path}: ${(error as NodeJS.ErrnoException).code === "ENOENT" ? "no such file" : (error as Error).message}`);
  }
}

export async function readJson(path: string, io: Io): Promise<unknown> {
  const text = await readText(path, io);
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new UsageError(`${path} is not valid JSON: ${(error as Error).message}`);
  }
}

export const RUN_ID_RE = /^0x[0-9a-fA-F]{64}$/;
export const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export function json(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2);
}
