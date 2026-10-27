/**
 * Runs the frozen meeting-answer eval against a chat backend and prints per-model pass rates, failures and the gate.
 *   bun backend/scripts/mcp-eval/run.ts [--backend=answer-key|eliza] [--models=a,b] [--baseline=path] [--json]
 * Makes no network calls: the built-in backends are an answer-key self-check and a stub.
 */
import { resolve } from "node:path";
import { createAnswerKeyBackend, elizaStubBackend } from "./backends.js";
import { formatReport, loadBaseline, loadFrozenEval, MCP_EVAL_DIR, runEval } from "./runner.js";

const args = new Map(process.argv.slice(2).map(arg => {
  const [key, ...value] = arg.replace(/^--/, "").split("=");
  return [key!, value.join("=") || "true"] as const;
}));
const known = new Set(["backend", "models", "baseline", "json"]);
for (const key of args.keys()) if (!known.has(key)) throw new Error(`unknown flag --${key}`);

const { cases, manifest } = await loadFrozenEval();
const backendName = args.get("backend") ?? "answer-key";
const backend = backendName === "eliza" ? elizaStubBackend : backendName === "answer-key" ? createAnswerKeyBackend(cases) : undefined;
if (!backend) throw new Error(`unknown backend "${backendName}" (answer-key | eliza)`);
const baseline = await loadBaseline(resolve(args.get("baseline") ?? `${MCP_EVAL_DIR}/baseline/eliza-ed320bd.json`));
const models = args.get("models")?.split(",");

const report = await runEval({ backend, models, cases, evalVersion: manifest.version, baseline });
console.log(args.has("json") ? JSON.stringify(report, null, 2) : formatReport(report));
process.exit(report.gatePassed ? 0 : 1);
