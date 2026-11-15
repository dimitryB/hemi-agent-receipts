// Checks each example receipt against its own network (Hemi mainnet or testnet) with the SDK's
// verify() and saves the results, with the RPC each used, to samples/recorded.json. The viewer shows a recorded result, labelled with this date, only
// when it cannot reach the network itself and the example's no-network checks agree with it.
// Run `npm run build -w sdk` first.
import { readFile, writeFile } from "node:fs/promises";
import { DEPLOYMENTS, HEMI_NETWORKS, defaultFinalityReader, verify } from "@hemi-receipts/sdk";

const dir = new URL("./samples/", import.meta.url);
const samples = JSON.parse(await readFile(new URL("index.json", dir), "utf8"));
const rpcs = {};
const results = {};
for (const s of samples) {
  const raw = JSON.parse(await readFile(new URL(s.file, dir), "utf8"));
  const rpc = HEMI_NETWORKS[raw.chainId].rpcUrls[0];
  rpcs[s.id] = rpc;
  const result = await verify(raw, {
    registry: DEPLOYMENTS[raw.chainId].registry,
    rpcUrls: [rpc],
    finality: defaultFinalityReader(raw.chainId),
  });
  if (result.incomplete || result.problems.some((p) => p.code === "rpc-error")) throw new Error(`${s.id}: the network did not answer every question; try again`);
  results[s.id] = result;
  console.log(`${s.id}: valid ${result.valid}, stage ${result.status?.stage ?? "-"}, problems ${result.problems.map((p) => p.code).join(", ") || "none"}`);
}
const recorded = { recordedAt: Math.floor(Date.now() / 1000), rpcs, results };
const json = JSON.stringify(recorded, (_key, value) => (typeof value === "bigint" ? Number(value) : value), 2);
await writeFile(new URL("recorded.json", dir), `${json}\n`);
console.log(`wrote ${new URL("recorded.json", dir).pathname}`);
