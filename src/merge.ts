// Merge stage: combine direct + semantic + optional manual edges into the
// final graph, dedupe, set `user_supplied: true` on params with no producer.

import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { CuratedTool, Edge, Graph, ToolNode } from "./types.ts";

const PRODUCER_VERBS = /(^|_|::)(LIST|GET|SEARCH|FETCH|CREATE|INSERT|ADD|LOOKUP|READ)(_|$)/i;
const CONSUMER_VERBS = /(^|_|::)(DELETE|UPDATE|PATCH|REMOVE|MERGE|CLOSE|REPLY|SEND|WRITE)(_|$)/i;

// Drop semantic edges where the LLM claimed a consumer-shaped tool (DELETE,
// UPDATE, PATCH, …) is the producer. The model occasionally argues "this
// mutation returns the id you passed in, therefore it's a producer" — true in
// some narrow API senses, but useless for an agent planning the order of
// actions: you wouldn't delete a resource to discover its id.
function isConsumerShaped(slug: string): boolean {
  return CONSUMER_VERBS.test(slug) && !PRODUCER_VERBS.test(slug);
}

function filterSemanticEdges(
  edges: Edge[],
  bySlug: Map<string, CuratedTool>,
): { kept: Edge[]; dropped: Edge[] } {
  const kept: Edge[] = [];
  const dropped: Edge[] = [];
  for (const e of edges) {
    if (e.type !== "semantic") {
      kept.push(e);
      continue;
    }
    if (isConsumerShaped(e.from)) {
      dropped.push(e);
      continue;
    }
    // Drop edges where the LLM claims a producer outputs an *id-shaped* value
    // that the producer itself REQUIRES as input. A tool can't discover the id
    // it needs to be called with (you can't `GET_AN_ISSUE` to find an
    // `issue_id` — you need the id to make the call).
    //
    // This filter is scoped to id-shaped param names (`<noun>_id` / `<noun>Id`)
    // because generic MCP-style params like `path` / `query` / `url` legitimately
    // appear on both sides: `list_directory` takes a path AND returns many paths
    // distinct from the input. Treating those as hallucinations nukes most of
    // the cross-tool chains within a typical MCP server.
    const isIdShaped = /(_id|Id)$/.test(e.consumes);
    if (isIdShaped) {
      const producer = bySlug.get(e.from);
      const prodRequired = producer?.inputParameters?.required ?? [];
      if (prodRequired.includes(e.consumes)) {
        dropped.push(e);
        continue;
      }
    }
    kept.push(e);
  }
  return { kept, dropped };
}

function dedupeEdges(edges: Edge[]): Edge[] {
  const seen = new Map<string, Edge>();
  for (const e of edges) {
    const key = `${e.from}|${e.to}|${e.consumes}`;
    const prev = seen.get(key);
    if (!prev) {
      seen.set(key, e);
      continue;
    }
    // direct beats semantic for the same triple
    if (prev.type === "semantic" && e.type === "direct") seen.set(key, e);
  }
  return [...seen.values()];
}

function toNode(tool: CuratedTool, edges: Edge[]): ToolNode {
  const required = tool.inputParameters?.required ?? [];
  const props = tool.inputParameters?.properties ?? {};
  const producersFor = new Set(
    edges.filter((e) => e.to === tool.slug).map((e) => e.consumes),
  );
  return {
    id: tool.slug,
    toolkit: tool.toolkit_slug,
    description: (tool.description || "").replace(/\s+/g, " ").trim(),
    required_params: required.map((p) => ({
      name: p,
      type: props[p]?.type ?? "?",
      description: (props[p]?.description ?? "").replace(/\s+/g, " ").trim(),
      user_supplied: !producersFor.has(p),
    })),
  };
}

async function main() {
  const curated: CuratedTool[] = JSON.parse(
    await readFile("data/curated.json", "utf-8"),
  );
  const direct: Edge[] = JSON.parse(
    await readFile("data/edges.direct.json", "utf-8"),
  );
  const semantic: Edge[] = existsSync("data/edges.semantic.json")
    ? JSON.parse(await readFile("data/edges.semantic.json", "utf-8"))
    : [];
  // Optional hand-curated edges. Treated like semantic edges but exempt from
  // the bogus-edge filter (a human already vetted them).
  const manual: Edge[] = existsSync("data/edges.manual.json")
    ? JSON.parse(await readFile("data/edges.manual.json", "utf-8"))
    : [];

  const bySlug = new Map(curated.map((t) => [t.slug, t] as const));
  const { kept: keptSem, dropped } = filterSemanticEdges(semantic, bySlug);
  if (dropped.length) {
    console.log(`merge: dropped ${dropped.length} consumer-shaped 'producer' semantic edges`);
  }
  const edges = dedupeEdges([...direct, ...keptSem, ...manual]);
  const nodes = curated.map((t) => toNode(t, edges));
  const graph: Graph = { nodes, edges };

  await writeFile("graph.json", JSON.stringify(graph, null, 2), "utf-8");
  await writeFile(
    "graph.js",
    `window.GRAPH = ${JSON.stringify(graph)};\n`,
    "utf-8",
  );

  const directCount = edges.filter((e) => e.type === "direct").length;
  const semCount = edges.filter((e) => e.type === "semantic").length;
  const userSupplied = nodes.reduce(
    (acc, n) => acc + n.required_params.filter((p) => p.user_supplied).length,
    0,
  );
  const totalParams = nodes.reduce(
    (acc, n) => acc + n.required_params.length,
    0,
  );
  console.log(`merge: ${nodes.length} nodes, ${edges.length} edges`);
  console.log(`  direct: ${directCount}, semantic: ${semCount}`);
  if (totalParams > 0) {
    console.log(
      `  user_supplied params: ${userSupplied} of ${totalParams} (${Math.round(
        (100 * userSupplied) / totalParams,
      )}%)`,
    );
  }
}

main();
