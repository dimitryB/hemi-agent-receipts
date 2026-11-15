import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { getReceipt, hashManifest, ManifestError, normalizeManifest, type ReceiptFile } from "@hemi-receipts/sdk";
import { parse } from "../args.js";
import { EXIT, Failure, json, readJson, RUN_ID_RE, serviceUrl, UsageError, type Io } from "../io.js";

export const usage = `receipts fetch <runId> [--service URL] [-o FILE] [--manifest FILE]

Saves the receipt file for a run (default <runId>.receipt.json; -o - prints it). With
--manifest, the local manifest is checked against the receipt's manifestHash and included,
so the file can be verified on its own later.`;

export async function fetchReceipt(argv: string[], io: Io): Promise<number> {
  const { values, positionals } = parse(argv, {
    service: { type: "string" },
    output: { type: "string", short: "o" },
    manifest: { type: "string" },
  });
  if (positionals.length !== 1 || !RUN_ID_RE.test(positionals[0]!)) throw new UsageError("give one runId (0x followed by 64 hex digits)");
  const runId = positionals[0]!.toLowerCase();

  let local;
  if (values.manifest) {
    try {
      local = normalizeManifest(await readJson(values.manifest, io));
    } catch (error) {
      if (error instanceof ManifestError) throw new Failure(`${values.manifest}: ${error.message}`);
      throw error;
    }
  }

  const fetched = await getReceipt(serviceUrl(values.service, io), runId, { fetch: io.fetch });
  const { status, ...rest } = fetched;
  const file: ReceiptFile = { ...rest };
  if (local) {
    const hash = hashManifest(local);
    if (hash !== file.receipt.manifestHash.toLowerCase()) {
      throw new Failure(`${values.manifest} hashes to ${hash}, but receipt ${runId} has manifestHash ${file.receipt.manifestHash}; not merging`);
    }
    if (local.runId !== runId) throw new Failure(`${values.manifest} is for run ${local.runId}, not ${runId}`);
    file.manifest = local;
  }

  const body = `${json(file)}\n`;
  const out = values.output ?? `${runId}.receipt.json`;
  if (out === "-") io.out(body);
  else {
    await writeFile(resolve(io.cwd, out), body);
    io.err(`wrote ${out} (stage ${status.stage}${file.manifest ? ", with manifest" : ", without manifest"})`);
  }
  if (!file.anchor) io.err(`note: ${runId} is not anchored yet; verify reports it invalid until its batch is on chain`);
  return EXIT.ok;
}
