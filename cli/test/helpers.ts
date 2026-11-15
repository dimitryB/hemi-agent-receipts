import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/main.js";
import type { Io } from "../src/io.js";

export const REPO = new URL("../../", import.meta.url).pathname;

export interface Ran {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs the CLI in-process with captured output and the given environment. */
export async function cli(argv: string[], options: { env?: Record<string, string | undefined>; cwd?: string; fetch?: Io["fetch"] } = {}): Promise<Ran> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(argv, {
    out: (t) => out.push(t.endsWith("\n") ? t.slice(0, -1) : t),
    err: (t) => err.push(t.endsWith("\n") ? t.slice(0, -1) : t),
    env: options.env ?? {},
    cwd: options.cwd ?? REPO,
    fetch: options.fetch ?? globalThis.fetch,
  });
  return { code, stdout: out.join("\n"), stderr: err.join("\n") };
}

export function tempDir(): { path: string; cleanup(): void } {
  const path = mkdtempSync(join(tmpdir(), "receipts-cli-"));
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) };
}
