---
name: mcp-tool-deps
description: Build a dependency graph over MCP server tool catalogs. Discovers which tools must run before others — both within a server and across servers. Use to plan multi-step agent actions, audit a new MCP server's tool surface, or visualize how multiple MCP servers compose.
---

# MCP Tool Dependency Graph

Builds a dependency graph over any set of MCP servers' tool catalogs. An edge `A → B` means: to execute `B`, you may first need to run `A` — because `A` produces a value `B` requires.

Captures two flavors of dependency:

- **Direct edges** — a producer tool's output name-matches a consumer tool's required input (e.g., `list_threads` produces `thread_id` consumed by `reply_to_thread`). Identified by deterministic slug + verb heuristics.
- **Semantic edges** — a producer's output *semantically* satisfies a consumer's input even when names don't match (e.g., `search_people` resolves a name to `recipient_email` for `send_email`). Identified by a per-consumer LLM pass.

Cross-server edges are enabled by default — the headline use case (e.g., `fetch::fetch → filesystem::write_file [content]`).

## When to use

Trigger this skill when the user wants to:

- Plan a multi-step MCP-agent action and know which tool produces a value another tool requires
- Audit a new or unfamiliar MCP server to see its tool surface and natural chains
- Visualize how multiple MCP servers compose (cross-server tool dependencies)
- Identify which params on which tools must come from the user (no producer in the catalog)

Do **not** trigger for: invoking an MCP tool, debugging an MCP server, or general MCP setup. This skill *introspects* a tool catalog — it does not call any of the tools it maps.

## Prerequisites

1. [Bun](https://bun.sh) runtime installed (or Node ≥ 18 with `npm`).
2. **One LLM API key** for the semantic-edge pass (auto-detected, in precedence order):
   - `ANTHROPIC_API_KEY` (Claude — recommended for highest quality)
   - `OPENAI_API_KEY` (GPT)
   - `GOOGLE_API_KEY` (Gemini — free tier works)
   - `OPENROUTER_API_KEY` (free-tier fallback chain — no credits required)
3. **MCP servers to map**, configured in `config/servers.json`. Default ships with `filesystem`, `fetch`, `github`. Each server is launched via `command + args + env` (stdio transport).
4. Per-server auth tokens forwarded via env (e.g., `GITHUB_TOKEN` → `GITHUB_PERSONAL_ACCESS_TOKEN` for the github MCP server).

## Procedure

```bash
# 1. install deps
bun install

# 2. configure secrets (.env)
cp .env.example .env
# add at least one LLM API key; add GITHUB_TOKEN if including the github MCP server

# 3. (optional) edit config/servers.json to point at the MCP servers you want mapped
#    default: filesystem + fetch + github

# 4. (optional) edit config/allow-list.json to restrict to specific tool slugs
#    missing or empty file = take all tools

# 5. fetch tool catalogs from each MCP server (spawns each via stdio)
bun src/fetch.ts

# 6. build the graph (curate -> heuristics -> semantic LLM pass -> merge)
bun src/build.ts

# steps 5 + 6 combined:
bun run skill

# 7. open the viz (no server required — single static page)
start index.html        # Windows
open index.html         # macOS
xdg-open index.html     # Linux

# optional: serve viz over http on :5173
bun src/serve.ts
```

## Outputs

| Path | Shape | Purpose |
|---|---|---|
| `graph.json` | `{nodes, edges}` | Canonical output. Consumed by `index.html` and any downstream tooling. |
| `index.html` + `graph.js` | static HTML/JS | Interactive viewer at repo root — editorial cartographic aesthetic, pan/zoom, click a node to see required params + producers + consumers. Hostable directly on any static site (CreateOS, GitHub Pages, Netlify, etc.). |
| `data/raw/<server>.json` | raw tool dump | Per-server `list_tools` response. Cached between runs. |
| `data/curated.json` | filtered tools | Subset after `config/allow-list.json` is applied. |
| `data/edges.direct.json` | direct edges | Heuristic-derived edges. |
| `data/edges.semantic.json` | semantic edges | LLM-derived edges, cached per consumer in `data/cache/semantic/`. |

## Node schema

Each node in `graph.json`:

```jsonc
{
  "id": "github::list_pull_requests",       // namespaced as <server>::<tool>
  "toolkit": "github",                       // server name (origin)
  "description": "List and filter ...",      // from the MCP server's tool definition
  "required_params": [
    {
      "name": "owner",
      "type": "string",
      "description": "Repository owner",
      "user_supplied": false                 // true if no producer found for this slot
    }
  ]
}
```

## Edge schema

```jsonc
{
  "from": "github::search_repositories",     // producer
  "to":   "github::list_pull_requests",      // consumer
  "consumes": "owner",                       // required-param slot on `to` this edge satisfies
  "type": "semantic",                        // "direct" | "semantic"
  "confidence": "medium",                    // "high" | "medium" | "low"
  "reason": "Searching repositories returns repository details including the owner's username or organization."
}
```

## Configuration files

### `config/servers.json`

```jsonc
{
  "servers": [
    {
      "name": "filesystem",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
    },
    {
      "name": "github",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "$GITHUB_TOKEN" }
    }
  ]
}
```

Env values prefixed with `$` are substituted from the caller's environment at fetch time.

### `config/allow-list.json` (optional)

```jsonc
{
  "github": ["search_repositories", "list_pull_requests", "merge_pull_request"]
}
```

Missing or empty → all tools from each server are included. Keys are server names; values are local tool names (no `<server>::` prefix).

## Notes & known limits

- The slug-noun heuristic (`<noun>_id` → look for producer tools containing `<noun>`) is largely inert for MCP's snake_case tool names. Composio-style `SCREAMING_SNAKE` toolkits yield more direct edges. Most MCP edges land via the semantic LLM pass — see [APPROACH.md](APPROACH.md) for design rationale.
- LLM provider precedence: `ANTHROPIC_API_KEY` > `OPENAI_API_KEY` > `GOOGLE_API_KEY` > `OPENROUTER_API_KEY`. Override with `LLM_PROVIDER=<provider>` and/or `LLM_MODEL=<model>`.
- Semantic pass caches per-consumer in `data/cache/semantic/<slug>.json`. Re-runs are cheap; partial failures survive.
- The viz is fully static — no server required, no build step. Open `index.html` directly via `file://` or any static host.

## References

- This repo: <https://github.com/adityachaudhary99/mcp-tool-deps>
- Live demo: <https://production-mcp-tool-deps.tyzo.nodeops.app>
- Skills CLI: <https://github.com/NodeOps-app/skills> (`npx skills add ...`)
- Design rationale: [APPROACH.md](APPROACH.md)
- MCP spec: <https://modelcontextprotocol.io>
