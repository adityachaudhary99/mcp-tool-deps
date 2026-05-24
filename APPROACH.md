# Tool Dependency Graph — Approach

A dependency graph over MCP server tool catalogs. An edge `A → B` means: to execute `B`, you may first need to run `A` — either because `B` requires an id/identifier that `A` produces (a *direct* edge), or because the user supplies a friendly identifier (a name, a path fragment, a URL) that `A` resolves into the value `B` actually needs (a *semantic* edge).

## Result at a glance

Default demo against `@modelcontextprotocol/server-filesystem` + `mcp-server-fetch`:

**15 nodes · 44 edges (0 direct, 44 semantic) · 1 of 18 required params is user-supplied.**

Cross-server headline: `fetch::fetch → filesystem::write_file [content]` — surfaced by the semantic pass with `"An agent commonly fetches content from the internet and then saves it to a local file."`

![screenshot](viz/screenshot.png)

## Design

### Per-param edges, namespaced slugs

Two design choices are load-bearing:

- **Edges attach to a specific consumer param**, not just to the consumer tool. The same producer might satisfy one of a consumer's three required params and not the other two; conflating tool → tool loses that signal.
- **Slugs are namespaced `<server>::<tool>`** so identically-named tools across servers (every MCP server tends to have its own `list`, `read`, `search`) get distinct identities. This makes the cross-server graph well-defined and lets the viz use server identity for color/grouping without re-deriving it.

### Heuristic + LLM + manual layers

- **Heuristic** ([`src/heuristics.ts`](src/heuristics.ts)) — for each consumer's required `<noun>_id` / `<noun>Id` param, find producer tools whose slug contains the noun and a producer verb (LIST/GET/SEARCH/FETCH/CREATE/READ/...). Case-insensitive. Cross-server matches allowed. Fast, deterministic, transparent. **Caveat:** most MCP servers use `snake_case` like `read_file`, `list_directory` — the param is `path`, not `<noun>_id` — so the slug heuristic is near-useless for MCP-native catalogs. It still shines on Composio-style `SCREAMING_SNAKE_CASE` (`GITHUB_GET_AN_ISSUE` → `issue_id`).

- **Semantic** ([`src/semantic.ts`](src/semantic.ts)) — one LLM call per consumer, given the consumer's params, the heuristic edges already found (to avoid repeats), and the full cross-server catalog. Returns JSON edges. Each returned edge is validated: the `from` must exist in the catalog, the `consumes` must be a real required param, duplicates of heuristic edges are dropped, and the merge stage additionally filters bogus shapes (see below).

  Provider auto-detected from env (Anthropic / OpenAI / Gemini / OpenRouter); the call function for each provider lives in `src/semantic.ts`. OpenRouter falls back through `:free`-tier models so the project runs end-to-end without paid credits.

- **Manual** ([`data/edges.manual.json`](data/edges.manual.json), optional) — a hand-curated edges file for cases the LLM consistently misses. Treated like semantic edges but exempt from the bogus-edge filter. Useful for asserting specific chains the demo should always show.

### Bogus-edge filter

`src/merge.ts` drops two classes of LLM hallucination:

1. **Producer slug is consumer-shaped.** Mutation tools (DELETE / UPDATE / PATCH / REMOVE / CLOSE / WRITE / SEND) sometimes get suggested as producers because their response payload echoes inputs. An agent doesn't delete a resource to discover its id.
2. **Producer requires the same id it claims to produce** — but *only* for id-shaped param names (`<noun>_id` / `<noun>Id`). For generic MCP param names like `path` / `query` / `url`, this filter is wrong: `list_directory` takes one `path` and legitimately returns many distinct `path`s, so dropping the edge nukes most of the chains inside a typical MCP server. The narrow scope keeps the Composio-style protection while letting MCP work.

### Caching

Per-consumer LLM responses are cached to `data/cache/semantic/<slug>.json` (with `::` and `/` replaced by `__` for filesystem safety). Re-running `bun src/semantic.ts` after a network failure picks up exactly where it left off. The cache is keyed by consumer slug only — change the prompt or the catalog and you should clear it.

## What's missing / would do with more time

- **HTTP/SSE MCP transport.** Only stdio is wired up. The MCP SDK ships both; adding the second is mechanical (config-flagged choice of transport class).
- **Output-schema-based direct matching.** MCP's `tools/list` doesn't include an output schema. When the protocol gains one (or when individual servers start declaring it), the heuristic could do real producer-output → consumer-input field matching instead of relying on slug shape.
- **Multi-hop chains.** The graph is one-hop. An agent runtime would compose them, but precomputing "shortest path from any producer to slot X" would speed up planning.
- **Confidence calibration.** `direct` is always `high` (deterministic); `semantic` confidences are the LLM's self-report — no independent calibration.
- **Wider per-server allow-list defaults.** `config/allow-list.json` is optional; bigger servers (e.g., github with ~30 tools) might want a focused subset to keep LLM calls cheap.

## File layout

```
config/
  servers.json                      # MCP servers to fetch from
  allow-list.json (optional)        # per-server tool name filter
data/
  raw/<server>.json                 # raw tools/list dumps, per server
  curated.json                      # namespaced + filtered tools
  edges.direct.json                 # heuristic output
  edges.semantic.json               # LLM output
  edges.manual.json (optional)      # hand-curated edges
  cache/semantic/<slug>.json        # per-consumer LLM cache
graph.json                          # final {nodes, edges} (canonical)
viz/
  index.html                        # Cytoscape viewer, dynamic per-server colors
  graph.js                          # window.GRAPH = ... (avoids file:// CORS)
  screenshot.png
src/
  types.ts
  fetch.ts                          # MCP stdio client → data/raw/
  curate.ts                         # raw/ → curated.json (namespacing + filter)
  heuristics.ts                     # → edges.direct.json
  semantic.ts                       # → edges.semantic.json (multi-provider)
  merge.ts                          # → graph.json + viz/graph.js
  build.ts                          # runs curate → heuristics → semantic → merge
  serve.ts                          # tiny static server on :5173 (optional)
```
