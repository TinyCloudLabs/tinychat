// Throwaway rehearsal runner. The parent runs this after the portable model is built.
// It reads source only, bundles legacy PURE modules into a temporary directory,
// compares synthetic cases, and removes that directory. No board or watcher IO.
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import * as candidate from "@tinyboilerplate/core/feed/sitrep";
import { FROZEN_SITREP_RECORDS, SITREP_CREATED, SITREP_NOW, SITREP_REASKED } from "./sitrep.fixtures";

const sourceRoot = process.env.SITREP_LEGACY_ROOT;
if (!sourceRoot) throw new Error("SITREP_LEGACY_ROOT must name the authorized read-only legacy checkout");
const legacyRoot = resolve(sourceRoot);
const temporary = mkdtempSync(join(tmpdir(), "tc2208-pure-conformance-"));
const sourceModules = { schema: "schema", board: "board", expiry: "expiry", holds: "holds", deps: "deps", upsert: "upsert", recipients: "recipients", thread: "card-thread", groups: "groups", priority: "priority", rank: "rank", priorityFlag: "priority-flag", links: "links", guard: "guard" };
function comparable(value: unknown): string {
  return JSON.stringify(value, (_key, item) => {
    if (item instanceof Map) return { map: [...item.entries()] };
    if (item instanceof Set) return { set: [...item] };
    return item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item;
  });
}
function invoke(module: Record<string, unknown>, name: string, args: unknown[]) {
  const fn = module[name];
  if (typeof fn !== "function") throw new Error(`Missing pure function ${name}`);
  return Reflect.apply(fn, undefined, args);
}
try {
  for (const origin of candidate.SITREP_MODEL_ORIGINS) {
    const observed = createHash("sha256").update(readFileSync(join(legacyRoot, origin.path))).digest("hex");
    assert.equal(observed, origin.sha256, `Captured source changed: ${origin.path}`);
  }
  const wrapper = join(temporary, "legacy-pure.ts");
  writeFileSync(wrapper, Object.entries(sourceModules).map(([name, file]) => `export * as ${name} from ${JSON.stringify(join(legacyRoot, "shared", `${file}.ts`))};`).join("\n"));
  const build = await Bun.build({ entrypoints: [wrapper], outdir: temporary, target: "bun", format: "esm", define: { "import.meta.env.VITE_PUBLIC_BUILD": "false", "import.meta.env.VITE_BRIEF_HOST": "undefined" } });
  if (!build.success) throw new Error(build.logs.map(String).join("\n"));
  const legacy = await import(pathToFileURL(build.outputs[0]!.path).href);
  let cases = 0;
  const compare = (module: string, name: string, args: unknown[]) => {
    const before = invoke(legacy[module], name, structuredClone(args));
    const after = invoke(candidate, name, structuredClone(args));
    assert.equal(comparable(after), comparable(before), `${module}.${name} diverged`);
    cases++;
    return before;
  };
  const records = FROZEN_SITREP_RECORDS.map((record) => {
    const result = compare("schema", "validateRecord", [record.kind, record]);
    if (!result.ok) throw new Error(`Invalid frozen ${record.kind}: ${result.errors.join("; ")}`);
    return result.value;
  });
  const ask = records.find((record) => record.kind === "ask");
  const task = records.find((record) => record.kind === "task");
  const approval = records.find((record) => record.kind === "approval");
  const hold = records.find((record) => record.kind === "hold");
  const answers = [
    { askId: ask.id, action: "answer", choice: "careful", text: "Current synthetic decision", at: "2026-10-29T11:00:00.000Z" },
    { askId: ask.id, action: "answer", choice: "quick", text: "Older record imported last", at: SITREP_CREATED },
  ];
  compare("board", "currentAnswer", [{ ...ask, lastAskedAt: SITREP_REASKED }, answers]);
  compare("board", "waitingReport", [{ records, answers, states: [] }, Date.parse(SITREP_NOW)]);
  compare("board", "askParts", [records, answers, Date.parse(SITREP_NOW)]);
  compare("board", "openApprovals", [records, [{ askId: approval.id, action: "done", text: "", issuedAt: SITREP_CREATED, at: SITREP_CREATED }], Date.parse(SITREP_NOW)]);
  for (const now of [Date.parse(SITREP_NOW) - 1, Date.parse(SITREP_NOW), Date.parse(SITREP_NOW) + 1]) compare("board", "steerState", [{ ...ask, mode: "proceeding", default: "quick", decideBy: SITREP_NOW }, now, []]);
  const state = { kind: "task", id: task.id, steps: { verify: SITREP_CREATED, undo: null }, updatedAt: SITREP_NOW, snoozedUntil: null, snoozes: [{ at: SITREP_CREATED, until: SITREP_NOW }] };
  compare("schema", "validateState", [state]);
  compare("expiry", "expiryOf", [task, state]);
  compare("expiry", "expiryOf", [task, { ...state, steps: { verify: SITREP_CREATED, undo: SITREP_NOW } }]);
  compare("holds", "holdGroups", [records, Date.parse(SITREP_NOW)]);
  compare("recipients", "recipients", [{ ...hold, owner: "SyntheticOwner / SyntheticOfficer / sam / SyntheticOwner" }]);
  for (const kind of ["ship", "order"]) {
    const record = records.find((candidate) => candidate.kind === kind);
    compare("upsert", "applyUpsert", [kind, record.id, record, { title: "Attempted historical rewrite" }, { now: SITREP_NOW, from: record.from }]);
  }
  for (const ref of ["task:task-synthetic", "hold:hold-synthetic", "ask:missing", "TC-1"]) {
    const oldGraph = legacy.deps.depGraph(records);
    const newGraph = candidate.depGraph(records);
    assert.equal(comparable(newGraph.resolve(ref)), comparable(oldGraph.resolve(ref)), `dependency ${ref}`);
    cases++;
  }
  compare("thread", "threadOwner", [ask]);
  compare("thread", "threadOwner", [records.find((record) => record.kind === "progress")]);
  compare("thread", "recentThread", [[{ side: "sam", kind: "ask", id: ask.id, at: SITREP_NOW, text: "Synthetic immutable message", messageId: "20261029T120000000Z-00000000000000000000000000000001" }]]);
  compare("links", "linkCaption", [{ label: "Private report", url: "https://reports.synthetic-example.ts.net/rehearsal.md" }]);
  compare("guard", "approvalUrlKind", ["https://openkey.so/delegate?fixture=synthetic"]);
  const origins = Object.values(sourceModules).map((file) => ({ path: `shared/${file}.ts`, sha256: createHash("sha256").update(readFileSync(join(legacyRoot, "shared", `${file}.ts`))).digest("hex") }));
  console.log(JSON.stringify({ conformance: "passed", cases, synthetic: true, origins }, null, 2));
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
