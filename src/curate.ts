// Curate the raw MCP tool dumps into the canonical `data/curated.json`.
//
// Reads `data/raw/<server>.json` for every server listed in
// `config/servers.json` (override via $SERVERS_CONFIG). Attaches each tool's
// origin server (`toolkit_slug`) and a namespaced slug (`<server>::<tool>`)
// so downstream stages can disambiguate identically named tools across servers.
//
// Optionally filters to an allow-list from `config/allow-list.json` (override
// via $ALLOW_LIST). The file maps `server name -> string[]` of tool names to
// keep. Missing file or empty array for a server means "keep all that server's
// tools".

import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import type { CuratedTool, RawTool, ServersFile } from "./types.ts";

const CONFIG_PATH = process.env.SERVERS_CONFIG ?? "config/servers.json";
const ALLOW_PATH = process.env.ALLOW_LIST ?? "config/allow-list.json";

async function loadAllowList(): Promise<Record<string, Set<string>> | null> {
  if (!existsSync(ALLOW_PATH)) return null;
  const raw = JSON.parse(await readFile(ALLOW_PATH, "utf-8")) as Record<string, string[]>;
  const out: Record<string, Set<string>> = {};
  for (const [server, names] of Object.entries(raw)) {
    out[server] = new Set(names);
  }
  return out;
}

async function loadServerDump(name: string): Promise<RawTool[]> {
  const path = `data/raw/${name}.json`;
  if (!existsSync(path)) {
    console.warn(`  ${name}: ${path} not found; skipping`);
    return [];
  }
  return JSON.parse(await readFile(path, "utf-8")) as RawTool[];
}

async function main() {
  const config: ServersFile = JSON.parse(await readFile(CONFIG_PATH, "utf-8"));
  const allow = await loadAllowList();
  if (allow) {
    console.log(`curate: allow-list loaded from ${ALLOW_PATH}`);
  }

  const all: CuratedTool[] = [];
  for (const server of config.servers) {
    const raw = await loadServerDump(server.name);
    const filter = allow?.[server.name];
    const picked: CuratedTool[] = [];
    for (const tool of raw) {
      if (filter && filter.size > 0 && !filter.has(tool.name)) continue;
      picked.push({ ...tool, slug: `${server.name}::${tool.name}`, toolkit_slug: server.name });
    }
    if (filter && filter.size > 0) {
      const missing = [...filter].filter((wanted) => !raw.some((t) => t.name === wanted));
      if (missing.length) {
        console.warn(`  ${server.name}: ${missing.length} allow-list entries not in dump:`);
        for (const m of missing) console.warn(`    - ${m}`);
      }
    }
    console.log(`  ${server.name}: ${picked.length} tools curated`);
    all.push(...picked);
  }

  await writeFile("data/curated.json", JSON.stringify(all, null, 2), "utf-8");
  console.log(`wrote ${all.length} curated tools to data/curated.json`);
}

main();
