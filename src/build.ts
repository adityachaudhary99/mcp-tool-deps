import { spawnSync } from "node:child_process";

const STAGES = ["src/curate.ts", "src/heuristics.ts", "src/semantic.ts", "src/merge.ts"];

// Use the current runner (e.g. the bun binary that started this script) so we
// don't depend on bun being on PATH.
const runner = process.execPath;

for (const stage of STAGES) {
  console.log(`\n=== ${stage} ===`);
  const r = spawnSync(runner, [stage], { stdio: "inherit" });
  if (r.status !== 0) {
    console.error(`stage failed: ${stage} (exit ${r.status})`);
    process.exit(r.status ?? 1);
  }
}
console.log("\nbuild complete. open index.html");
