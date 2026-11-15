// Serves viewer/dist on http://127.0.0.1:${VIEWER_PORT:-5180}. No dependencies.
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { dirname, extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "dist");
const port = Number(process.env.VIEWER_PORT ?? 5180);
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".map": "application/json", ".txt": "text/plain" };

createServer(async (req, res) => {
  let path;
  try {
    // A malformed escape (`/%`) or request target throws here: answer it, never crash the server.
    path = normalize(decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname)).replace(/^(\.\.[/\\])+/, "");
  } catch {
    return void res.writeHead(400, { "content-type": "text/plain" }).end("bad request");
  }
  let file = join(root, path);
  if (file !== root && !file.startsWith(root + sep)) return void res.writeHead(403).end();
  let body;
  try {
    if ((await stat(file)).isDirectory()) file = join(file, "index.html");
    body = await readFile(file);
  } catch {
    return void res.writeHead(404, { "content-type": "text/plain" }).end("not found");
  }
  // Headers only once the file is read, so a failed read can still answer 404.
  res.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" }).end(body);
}).listen(port, "127.0.0.1", () => console.log(`receipt viewer on http://127.0.0.1:${port}`));
