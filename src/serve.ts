// Tiny static server for the viz so playwright/browsers can load it.
// Not part of the build pipeline — just for verification.
import { readFile } from "node:fs/promises";
import { extname } from "node:path";

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".json": "application/json",
  ".css": "text/css",
};

Bun.serve({
  port: 5173,
  async fetch(req) {
    const url = new URL(req.url);
    let path = url.pathname === "/" ? "/viz/index.html" : url.pathname;
    if (path.startsWith("/graph.js")) path = "/viz/graph.js"; // index.html refs ./graph.js
    try {
      const data = await readFile(`.${path}`);
      return new Response(data, {
        headers: { "Content-Type": MIME[extname(path)] ?? "application/octet-stream" },
      });
    } catch {
      return new Response("404", { status: 404 });
    }
  },
});
console.log("http://localhost:5173/");
