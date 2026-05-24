// Semantic-edge pass via an LLM.
//
// For each curated consumer tool, ask an LLM for edges the deterministic
// heuristic missed. Each response is cached to `data/cache/semantic/<slug>.json`
// (replacing '/' and '::' with '__' for filesystem safety) so re-runs are cheap.
//
// Provider selection:
//   - Detects which provider's API key is set (ANTHROPIC_API_KEY, OPENAI_API_KEY,
//     GOOGLE_API_KEY, OPENROUTER_API_KEY).
//   - When multiple are set, picks the highest-quality available: Anthropic >
//     OpenAI > Gemini > OpenRouter.
//   - Override with LLM_PROVIDER=anthropic|openai|gemini|openrouter.
//   - Override model with LLM_MODEL=...
//   - OpenRouter has a built-in `:free`-tier fallback chain when LLM_MODEL is
//     unset, so it works without credits.

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { z } from "zod";
import type { CuratedTool, Edge } from "./types.ts";

type Provider = "anthropic" | "openai" | "gemini" | "openrouter";

type ProviderConfig = {
  envKey: string;
  defaultModels: string[];
  call: (prompt: string, apiKey: string, model: string) => Promise<string>;
};

const PROVIDERS: Record<Provider, ProviderConfig> = {
  anthropic: {
    envKey: "ANTHROPIC_API_KEY",
    defaultModels: ["claude-sonnet-4-5"],
    call: callAnthropic,
  },
  openai: {
    envKey: "OPENAI_API_KEY",
    defaultModels: ["gpt-4o-mini"],
    call: callOpenAI,
  },
  gemini: {
    envKey: "GOOGLE_API_KEY",
    defaultModels: ["gemini-2.5-flash"],
    call: callGemini,
  },
  openrouter: {
    envKey: "OPENROUTER_API_KEY",
    // :free-tier fallback chain — these are rate-limited and inconsistent but
    // make the tool work without credits. Override with LLM_MODEL for a paid
    // model and the array collapses to a single attempt.
    defaultModels: [
      "google/gemma-4-31b-it:free",
      "qwen/qwen3-next-80b-a3b-instruct:free",
      "minimax/minimax-m2.5:free",
      "nvidia/nemotron-3-nano-30b-a3b:free",
      "deepseek/deepseek-v4-flash:free",
    ],
    call: callOpenRouter,
  },
};

const PRECEDENCE: Provider[] = ["anthropic", "openai", "gemini", "openrouter"];

function pickProvider(): { provider: Provider; apiKey: string; models: string[] } {
  const forced = process.env.LLM_PROVIDER as Provider | undefined;
  const modelOverride = process.env.LLM_MODEL;
  const order = forced ? [forced] : PRECEDENCE;
  for (const p of order) {
    const cfg = PROVIDERS[p];
    if (!cfg) continue;
    const key = process.env[cfg.envKey];
    if (key) {
      const models = modelOverride ? [modelOverride] : cfg.defaultModels;
      return { provider: p, apiKey: key, models };
    }
  }
  const keys = PRECEDENCE.map((p) => PROVIDERS[p].envKey).join(", ");
  throw new Error(
    `No LLM provider key set. Copy .env.example to .env and set one of: ${keys}.`,
  );
}

const CACHE_DIR = "data/cache/semantic";

const SemanticEdge = z.object({
  from: z.string(),
  consumes: z.string(),
  confidence: z.enum(["high", "medium", "low"]),
  reason: z.string(),
});
const LLMResponse = z.object({
  edges: z.array(SemanticEdge).nullish().transform((v) => v ?? []),
});

function summarize(tool: CuratedTool): string {
  const desc = (tool.description || "").replace(/\s+/g, " ").slice(0, 220);
  return `- ${tool.slug}: ${desc}`;
}

function consumerInputs(tool: CuratedTool): string[] {
  const req = tool.inputParameters?.required ?? [];
  if (req.length > 0) return req;
  return Object.keys(tool.inputParameters?.properties ?? {});
}

function consumerBlock(tool: CuratedTool): string {
  const req = consumerInputs(tool);
  const props = tool.inputParameters?.properties ?? {};
  const paramLines = req.map((p) => {
    const meta = props[p] ?? {};
    const t = meta.type ?? "?";
    const d = (meta.description ?? "").replace(/\s+/g, " ").slice(0, 160);
    return `  - ${p} (${t}): ${d}`;
  });
  return [
    `CONSUMER: ${tool.slug}`,
    `description: ${(tool.description || "").replace(/\s+/g, " ").slice(0, 300)}`,
    `required_params:`,
    ...paramLines,
  ].join("\n");
}

function buildPrompt(
  consumer: CuratedTool,
  catalog: CuratedTool[],
  alreadyFound: Edge[],
): string {
  const catalogText = catalog
    .filter((t) => t.slug !== consumer.slug)
    .map(summarize)
    .join("\n");
  const foundText = alreadyFound.length
    ? alreadyFound.map((e) => `  - ${e.from} produces "${e.consumes}"`).join("\n")
    : "  (none)";
  return `You are auditing a tool dependency graph for an AI agent.

${consumerBlock(consumer)}

EDGES ALREADY FOUND by name-match heuristic (do not repeat these):
${foundText}

CATALOG OF AVAILABLE PRODUCER TOOLS (across all servers):
${catalogText}

Return JSON with this exact shape:
{ "edges": [{ "from": "<producer slug from catalog>", "consumes": "<required param name>", "confidence": "high"|"medium"|"low", "reason": "<one sentence>" }] }

Find edges the name-match heuristic MISSED. Focus on SEMANTIC resolutions where one tool's output naturally satisfies another's input even though field names differ — for example, a search/list tool resolving a user-friendly name into the id/email/path another tool requires, or one server's output being a sensible input for another server's tool (e.g., a fetch tool's downloaded payload being written by a filesystem tool).

Rules:
- "from" MUST be a slug present in the CATALOG above (use the full "<server>::<tool>" form). Do not invent slugs.
- "consumes" MUST be a name from the consumer's required_params list above.
- "from" must be a tool that an agent would naturally call BEFORE the consumer to discover or resolve the input. Mutation tools (DELETE, UPDATE, PATCH, REMOVE, CLOSE, WRITE) are NOT producers, even if their response payload echoes the id you passed in.
- An empty edges array is BETTER than a weak edge. Only return edges where the producer-to-consumer order is obviously what a user would want.
- Do NOT repeat edges from "already found".
- Reply with ONLY the JSON object, no prose, no markdown fences.`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function extractJson(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenced) return fenced[1]!.trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end > start) return text.slice(start, end + 1);
  return text.trim();
}

function attachStatus(err: unknown, status: number): Error {
  const e = err instanceof Error ? err : new Error(String(err));
  (e as Error & { status: number }).status = status;
  return e;
}

async function callAnthropic(prompt: string, apiKey: string, model: string): Promise<string> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: 3000,
      temperature: 0,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) {
    throw attachStatus(new Error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 200)}`), res.status);
  }
  const body = (await res.json()) as { content?: { type: string; text?: string }[] };
  const block = body.content?.find((b) => b.type === "text");
  return block?.text ?? "";
}

async function callOpenAI(prompt: string, apiKey: string, model: string): Promise<string> {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
      temperature: 0,
      max_tokens: 3000,
    }),
  });
  if (!res.ok) {
    throw attachStatus(new Error(`OpenAI ${res.status}: ${(await res.text()).slice(0, 200)}`), res.status);
  }
  const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  return body.choices?.[0]?.message?.content ?? "";
}

async function callGemini(prompt: string, apiKey: string, model: string): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: "application/json", temperature: 0, maxOutputTokens: 3000 },
    }),
  });
  if (!res.ok) {
    throw attachStatus(new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 200)}`), res.status);
  }
  const body = (await res.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };
  return body.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
}

async function callOpenRouter(prompt: string, apiKey: string, model: string): Promise<string> {
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
      temperature: 0,
      max_tokens: 3000,
    }),
  });
  if (!res.ok) {
    throw attachStatus(new Error(`OpenRouter ${res.status}: ${(await res.text()).slice(0, 200)}`), res.status);
  }
  const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  return body.choices?.[0]?.message?.content ?? "";
}

async function callWithFallback(
  prompt: string,
  provider: Provider,
  apiKey: string,
  models: string[],
): Promise<unknown> {
  // On 429 the same model won't recover within seconds, so move to next model.
  // Only retry the SAME model on 5xx (often transient).
  let lastErr: unknown;
  const callFn = PROVIDERS[provider].call;
  for (const model of models) {
    try {
      const content = await callFn(prompt, apiKey, model);
      return JSON.parse(extractJson(content));
    } catch (err) {
      lastErr = err;
      const status = (err as Error & { status?: number }).status;
      if (status !== undefined && status >= 500) {
        await sleep(600);
        try {
          const content = await callFn(prompt, apiKey, model);
          return JSON.parse(extractJson(content));
        } catch (err2) {
          lastErr = err2;
        }
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("all models failed");
}

function cacheFileFor(slug: string): string {
  // `::` is fine on POSIX but a sentinel for filesystem safety on Windows. Both
  // path separators get sanitized to `__`.
  return `${CACHE_DIR}/${slug.replace(/[/:\\]/g, "_")}.json`;
}

async function loadCachedSlugs(): Promise<Map<string, string>> {
  if (!existsSync(CACHE_DIR)) return new Map();
  const files = await readdir(CACHE_DIR);
  const out = new Map<string, string>();
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    out.set(f.replace(/\.json$/, ""), `${CACHE_DIR}/${f}`);
  }
  return out;
}

async function main() {
  const { provider, apiKey, models } = pickProvider();
  console.log(`semantic: provider=${provider} model=${models[0]}${models.length > 1 ? ` (+${models.length - 1} fallbacks)` : ""}`);

  await mkdir(CACHE_DIR, { recursive: true });
  const curated: CuratedTool[] = JSON.parse(
    await readFile("data/curated.json", "utf-8"),
  );
  const direct: Edge[] = JSON.parse(
    await readFile("data/edges.direct.json", "utf-8"),
  );
  const slugSet = new Set(curated.map((t) => t.slug));
  const cached = await loadCachedSlugs();
  const all: Edge[] = [];
  let okCount = 0;
  let failCount = 0;

  for (const consumer of curated) {
    const required = consumerInputs(consumer);
    if (required.length === 0) continue;

    const safeKey = consumer.slug.replace(/[/:\\]/g, "_");
    if (cached.has(safeKey)) {
      const prev: Edge[] = JSON.parse(await readFile(cached.get(safeKey)!, "utf-8"));
      all.push(...prev);
      okCount++;
      console.log(`semantic: ${consumer.slug} (cached, +${prev.length})`);
      continue;
    }

    const found = direct.filter((e) => e.to === consumer.slug);
    // Cross-server semantic edges are part of the point — feed the LLM the
    // full catalog rather than just same-server tools.
    const catalog = curated;
    const prompt = buildPrompt(consumer, catalog, found);
    process.stdout.write(`semantic: ${consumer.slug} ... `);
    let parsed: unknown;
    try {
      parsed = await callWithFallback(prompt, provider, apiKey, models);
    } catch (err) {
      console.log(`FAIL ${err instanceof Error ? err.message : String(err)}`);
      failCount++;
      await sleep(1500);
      continue;
    }
    const validated = LLMResponse.safeParse(parsed);
    if (!validated.success) {
      console.log("bad-shape");
      failCount++;
      await sleep(800);
      continue;
    }
    const consumerEdges: Edge[] = [];
    for (const e of validated.data.edges) {
      if (!slugSet.has(e.from)) continue;
      if (e.from === consumer.slug) continue;
      if (!required.includes(e.consumes)) continue;
      const duplicate = direct.some(
        (d) => d.from === e.from && d.to === consumer.slug && d.consumes === e.consumes,
      );
      if (duplicate) continue;
      consumerEdges.push({
        from: e.from,
        to: consumer.slug,
        consumes: e.consumes,
        type: "semantic",
        confidence: e.confidence,
        reason: e.reason,
      });
    }
    await writeFile(cacheFileFor(consumer.slug), JSON.stringify(consumerEdges, null, 2), "utf-8");
    all.push(...consumerEdges);
    okCount++;
    console.log(`+${consumerEdges.length}`);
    // be polite to free tier / per-minute rate limits
    await sleep(provider === "openrouter" ? 800 : 200);
  }

  await writeFile("data/edges.semantic.json", JSON.stringify(all, null, 2), "utf-8");
  console.log(`\nsemantic: ${all.length} edges total (ok=${okCount}, fail=${failCount})`);
}

main();
