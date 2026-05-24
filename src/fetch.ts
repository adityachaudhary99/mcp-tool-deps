// Fetch tool catalogs from MCP servers over stdio.
//
// Reads `config/servers.json` (override via $SERVERS_CONFIG). For each server,
// spawns the configured process, calls `tools/list`, normalizes each tool to
// RawTool, and writes the per-server dump to `data/raw/<server-name>.json`.
//
// Env-var expansion: any value `$NAME` in a server's `env` map is replaced by
// `process.env.NAME` at spawn time. Empty/unset variables are dropped so MCP
// servers don't see literal `$NAME`.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RawTool, ServerConfig, ServersFile } from "./types.ts";

const CONFIG_PATH = process.env.SERVERS_CONFIG ?? "config/servers.json";
const OUT_DIR = "data/raw";

function expandEnv(envMap: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!envMap) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(envMap)) {
    const expanded = v.replace(/\$(\w+)/g, (_, name) => process.env[name] ?? "");
    if (expanded) out[k] = expanded;
  }
  return out;
}

type McpTool = {
  name: string;
  description?: string;
  inputSchema?: {
    type?: string;
    properties?: Record<string, { type?: string; description?: string }>;
    required?: string[];
  };
};

function normalize(t: McpTool): RawTool {
  return {
    name: t.name,
    description: t.description ?? "",
    inputParameters: {
      type: t.inputSchema?.type,
      properties: t.inputSchema?.properties,
      required: t.inputSchema?.required,
    },
  };
}

async function fetchOne(server: ServerConfig): Promise<RawTool[]> {
  const transport = new StdioClientTransport({
    command: server.command,
    args: server.args ?? [],
    env: expandEnv(server.env),
    stderr: "pipe",
  });
  const client = new Client({ name: "mcp-tool-deps", version: "0.1.0" }, { capabilities: {} });

  try {
    await client.connect(transport);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`connect failed for ${server.name}: ${msg}`);
  }

  try {
    const result = await client.listTools();
    return (result.tools ?? []).map((t) => normalize(t as McpTool));
  } finally {
    await client.close().catch(() => {});
  }
}

async function main() {
  const configRaw = await readFile(CONFIG_PATH, "utf-8");
  const config: ServersFile = JSON.parse(configRaw);
  await mkdir(OUT_DIR, { recursive: true });

  let okCount = 0;
  let failCount = 0;

  for (const server of config.servers) {
    process.stdout.write(`fetch: ${server.name} ... `);
    try {
      const tools = await fetchOne(server);
      const out = join(OUT_DIR, `${server.name}.json`);
      await writeFile(out, JSON.stringify(tools, null, 2), "utf-8");
      console.log(`${tools.length} tools -> ${out}`);
      okCount++;
    } catch (err) {
      console.log(`FAIL ${err instanceof Error ? err.message : String(err)}`);
      failCount++;
    }
  }

  console.log(`\nfetch: ok=${okCount} fail=${failCount}`);
  if (okCount === 0) process.exit(1);
}

main();
