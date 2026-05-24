// Direct-edge pass.
//
// For each curated *consumer* tool, for each required param of consumer that
// matches `<noun>_id` / `<noun>Id`, look across the entire catalog (any server)
// for producer tools whose slug contains `<noun>` AND a producer-shaped verb
// (list / get / search / create / ...). Cross-server edges are allowed by
// design — when fetch + filesystem are both loaded, `fetch::fetch` producing a
// payload that `filesystem::write_file` writes is exactly the kind of chain
// the graph should surface.
//
// Matching is case-insensitive so MCP's typical `snake_case` and Composio-style
// `SCREAMING_SNAKE_CASE` both work.

import { readFile, writeFile } from "node:fs/promises";
import type { CuratedTool, Edge } from "./types.ts";

const PRODUCER_VERBS = ["LIST", "GET", "SEARCH", "FETCH", "CREATE", "INSERT", "ADD", "LOOKUP", "READ"];

function extractNoun(paramName: string): string | null {
  const snake = paramName.match(/^(.+?)_id$/i);
  if (snake?.[1]) return snake[1].toUpperCase();
  const camel = paramName.match(/^(.+?)Id$/);
  if (camel?.[1]) return camel[1].toUpperCase();
  return null;
}

function isProducerVerb(slug: string): boolean {
  return PRODUCER_VERBS.some((v) => new RegExp(`(^|_|::)${v}(_|$)`, "i").test(slug));
}

function slugContainsNoun(slug: string, noun: string): boolean {
  return new RegExp(`(^|_|::)${noun}S?(_|$)`, "i").test(slug);
}

function requiredParams(tool: CuratedTool): string[] {
  return tool.inputParameters?.required ?? [];
}

function buildEdges(curated: CuratedTool[]): Edge[] {
  const edges: Edge[] = [];
  for (const consumer of curated) {
    for (const param of requiredParams(consumer)) {
      const noun = extractNoun(param);
      if (!noun) continue;
      for (const producer of curated) {
        if (producer.slug === consumer.slug) continue;
        if (!slugContainsNoun(producer.slug, noun)) continue;
        if (!isProducerVerb(producer.slug)) continue;
        edges.push({
          from: producer.slug,
          to: consumer.slug,
          consumes: param,
          produces: param,
          type: "direct",
          confidence: "high",
          reason: `producer slug contains "${noun.toLowerCase()}" + producer verb`,
        });
      }
    }
  }
  return edges;
}

async function main() {
  const curated: CuratedTool[] = JSON.parse(
    await readFile("data/curated.json", "utf-8"),
  );
  const edges = buildEdges(curated);
  await writeFile(
    "data/edges.direct.json",
    JSON.stringify(edges, null, 2),
    "utf-8",
  );
  console.log(`heuristics: ${edges.length} direct edges`);
  const byConsumer = new Map<string, number>();
  for (const e of edges) byConsumer.set(e.to, (byConsumer.get(e.to) ?? 0) + 1);
  console.log("  top consumers:");
  [...byConsumer.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .forEach(([k, v]) => console.log(`    ${k}: ${v} producers`));
}

main();
