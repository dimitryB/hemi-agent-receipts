// Bundles the viewer (SDK and viem included) into viewer/dist/: index.html, styles.css,
// app.js and the example receipts. Run `npm run build -w sdk` first.
import { build } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "dist");
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
await build({
  entryPoints: [join(here, "src/main.ts")],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  minify: true,
  sourcemap: true,
  legalComments: "linked",
  outfile: join(out, "app.js"),
  logLevel: "warning",
});
await cp(join(here, "index.html"), join(out, "index.html"));
await cp(join(here, "styles.css"), join(out, "styles.css"));
await cp(join(here, "samples"), join(out, "samples"), { recursive: true });
console.log(`viewer built in ${out}`);
