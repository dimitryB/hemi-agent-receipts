// Turns the built viewer (viewer/dist, from build.mjs) into a claude.ai Artifact in
// viewer/dist/artifact: the page as a body fragment with its stylesheet and script inlined (the
// publisher wraps it in its own document), plus the examples and the bundle's licence notices
// as supporting files, which the page fetches by relative URL.
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "dist");
const out = join(dist, "artifact");
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

const html = await readFile(join(dist, "index.html"), "utf8");
const css = await readFile(join(dist, "styles.css"), "utf8");
const title = /<title>([^<]+)<\/title>/.exec(html)?.[1];
const body = /<body>([\s\S]*)<\/body>/.exec(html)?.[1];
if (!title || !body) throw new Error("dist/index.html has no <title> or <body>; run build.mjs first");
if (css.includes("</style")) throw new Error("styles.css cannot be inlined: it contains </style");

// No source map in the artifact: drop the comment that points at one.
const app = (await readFile(join(dist, "app.js"), "utf8")).replace(/\n\/\/# sourceMappingURL=app\.js\.map\s*$/, "\n");
if (/<\/script|<!--|<script/i.test(app)) throw new Error("app.js cannot be inlined: it contains a script or comment tag");
const script = '<script type="module" src="app.js"></script>';
if (!body.includes(script)) throw new Error(`dist/index.html does not load the bundle with ${script}`);

const page = [
  `<title>${title}</title>`,
  `<meta name="claude:viewport-fit-sides" content="cover">`,
  `<style>\n${css}</style>`,
  body.trim().replace(script, () => `<script type="module">\n${app}</script>`),
  "",
].join("\n");
await writeFile(join(out, "index.html"), page);
await cp(join(dist, "app.js.LEGAL.txt"), join(out, "app.js.LEGAL.txt"));
await cp(join(dist, "samples"), join(out, "samples"), { recursive: true });
console.log(`artifact built in ${out}`);
