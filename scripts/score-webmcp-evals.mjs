import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";

import { scoreWebMcpEvalCorpus } from "../src/webmcp/evalScorer.js";

const tracePath = process.argv[2];
const outputPath = process.argv[3];
if (!tracePath) {
  console.error("Usage: node scripts/score-webmcp-evals.mjs <model-traces.json> [report.json]");
  process.exit(2);
}

const corpusPath = resolve("tests/fixtures/webmcp/evals.json");
const [corpus, traces] = await Promise.all([
  readFile(corpusPath, "utf8").then(JSON.parse),
  readFile(resolve(tracePath), "utf8").then(JSON.parse),
]);
const runs = Array.isArray(traces) ? traces : traces.runs ?? (traces.evalCase?.id ? [{ id: traces.evalCase.id, calls: traces.calls ?? [] }] : []);
const report = scoreWebMcpEvalCorpus(corpus, runs);
const serialized = `${JSON.stringify(report, null, 2)}\n`;
if (outputPath) await writeFile(resolve(outputPath), serialized, "utf8");
process.stdout.write(serialized);
if (report.summary.failed || report.summary.incomplete) process.exitCode = 1;
