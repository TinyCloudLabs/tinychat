import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { load as loadYaml } from "js-yaml";
import * as build from "../../../log-shipper/build.mjs";
import { MAX_DAILY_BYTE_BUDGET, MAX_DROPPED_LINES, estimateBytes, lineCeiling } from "../../../log-shipper/limits.mjs";
import { reviewedCallSites, scanCallSites } from "../../../log-shipper/scan.mjs";

// TC-1978. Never touch a real home: HOME and the tool homes point at a throwaway directory for the whole file.
const scratch = mkdtempSync("/var/tmp/tc1978.");
process.env.HOME = scratch;
process.env.BUN_INSTALL_CACHE_DIR = join(scratch, "cache");
if (!process.env.HOME.startsWith("/var/tmp/tc1978.")) throw new Error("refusing to run against a real HOME");
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const root = resolve(import.meta.dir, "../../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

type Service = {
  image?: string;
  depends_on?: unknown;
  environment?: Record<string, string>;
  entrypoint?: string[];
  labels?: Record<string, string>;
  logging?: { driver?: string; options?: Record<string, string> };
  ports?: string[];
  networks?: string[];
  restart?: string;
  cap_drop?: string[];
  read_only?: boolean;
};
type Compose = { services: Record<string, Service>; networks?: Record<string, unknown> };
const compose = loadYaml(read("docker-compose.phala.yml")) as Compose;
const backend = compose.services["tinychat-backend"]!;
const vector = compose.services.vector!;

type Step = { name?: string; env?: Record<string, string>; run?: string };
const workflowText = read(".github/workflows/deploy-backend-phala.yml");
const workflow = loadYaml(workflowText) as { jobs: { deploy: { steps: Step[] } } };
const deployStep = workflow.jobs.deploy.steps.find((step) => step.run?.includes('ENV_FILE="$RUNNER_TEMP/phala-prod.env"'))!;

const fields = JSON.parse(read("log-shipper/fields.json")) as { services: Record<string, { events: string[]; fields: Record<string, any> }>; common: Record<string, any> };
const schema = fields.services["tinychat-backend"]!;
const registry = (JSON.parse(read("log-shipper/diagnostics.json")) as { entries: { text: string; code: string; component: string; level: string }[] }).entries;

describe("log shipping sidecar (TC-1978)", () => {
  test("the sidecar image is pinned by digest and is the image the node ships with", () => {
    expect(vector.image).toMatch(/^timberio\/vector:0\.59\.0-alpine@sha256:[0-9a-f]{64}$/);
    expect(vector.image).toBe(build.vectorImage);
  });

  test("the backend never waits for the sidecar: no dependency in either direction, and the sidecar is never the backend's network", () => {
    expect(backend.depends_on).toBeUndefined();
    expect(vector.depends_on).toBeUndefined();
    for (const [name, service] of Object.entries(compose.services)) {
      const dependencies = Array.isArray(service.depends_on) ? service.depends_on : Object.keys((service.depends_on as object | undefined) ?? {});
      expect(dependencies, `${name} must not depend on the log shipper`).not.toContain("vector");
    }
    expect(vector.networks).toEqual(["logship"]);
    expect(backend.networks).toBeUndefined();
    expect(vector.restart).toBe("unless-stopped");
  });

  test("the backend logs through the host gelf driver to the loopback listener, nonblocking, with no local copy", () => {
    expect(backend.logging?.driver).toBe("gelf");
    expect(backend.logging?.options).toMatchObject({
      "gelf-address": "udp://127.0.0.1:12201",
      mode: "non-blocking",
      labels: "tc.logship",
      "cache-disabled": "true",
    });
    expect(backend.labels).toEqual({ "tc.logship": "tinychat-backend" });
    // The sidecar only listens on the host loopback: nothing is reachable from the network or the Phala gateway.
    expect(vector.ports).toEqual(["127.0.0.1:12201:12201/udp"]);
    expect(compose.services["dstack-ingress"]?.logging).toBeUndefined();
  });

  test("the token and host reach only the sidecar, optionally, and never the backend", () => {
    expect(vector.environment?.BETTERSTACK_SOURCE_TOKEN).toBe("${BETTERSTACK_SOURCE_TOKEN:-}");
    expect(vector.environment?.BETTERSTACK_INGEST_HOST).toBe("${BETTERSTACK_INGEST_HOST:-}");
    expect(vector.environment?.BETTERSTACK_DAILY_BYTE_BUDGET).toBe("${BETTERSTACK_DAILY_BYTE_BUDGET:-}");
    expect(vector.environment?.BETTERSTACK_MAX_LINES_PER_MINUTE).toBe("${BETTERSTACK_MAX_LINES_PER_MINUTE:-}");
    expect(JSON.stringify(backend)).not.toContain("BETTERSTACK");
    expect(JSON.stringify(compose.services["dstack-ingress"])).not.toContain("BETTERSTACK");
    // The token is written to a 0600 file and unset before vector starts; it never enters either config.
    const script = vector.entrypoint!.at(-1)!;
    expect(script).toContain("umask 077");
    expect(script).toContain("> /var/lib/vector/secrets/bs_token");
    expect(script.indexOf("unset BETTERSTACK_SOURCE_TOKEN VECTOR_CONFIG_JSON VECTOR_SHIP_JSON\nexec vector")).toBeGreaterThan(script.indexOf("bs_token"));
    expect(vector.environment?.VECTOR_CONFIG_JSON).not.toContain("BETTERSTACK_SOURCE_TOKEN");
    expect(vector.environment?.VECTOR_SHIP_JSON).not.toContain("BETTERSTACK_SOURCE_TOKEN");
  });

  test("an absent token or host keeps the sidecar running local-only: one fixed line, no ship config, no exit a restart policy would loop on", () => {
    const script = vector.entrypoint!.at(-1)!;
    const absent = script.slice(script.indexOf('if [ -z "$$BETTERSTACK_SOURCE_TOKEN" ]'), script.indexOf("else\n"));
    expect(absent).toContain("local filtered log only");
    expect(absent).toContain("ingest host absent or invalid");
    expect(absent).not.toContain("ship.json");
    expect(script).not.toMatch(/\bexit\b/);
    // The ship config and the token file exist only in the branch where both the token and a valid host are present.
    const shipping = script.slice(script.indexOf("else\n"), script.indexOf("fi\nunset"));
    expect(shipping).toContain("bs_token");
    expect(shipping).toContain('--config /var/lib/vector/ship.json');
    // The host is substituted only after the charset and suffix check above, so it cannot carry sed syntax or a different authority.
    expect(shipping).toContain('sed "s/__INGEST_HOST__/$$BETTERSTACK_INGEST_HOST/" > /var/lib/vector/ship.json');
    expect(script.indexOf("ship.json")).toBeGreaterThan(script.indexOf("else\n"));
    // The host must be a plain *.betterstackdata.com name before the token is ever written.
    expect(script).toContain("*.betterstackdata.com) host_ok=1");
    expect(script).toContain("''|*[!a-z0-9.-]*|.*|-*|*..*) ;;");
  });

  test("the sidecar runs with no capabilities, a read-only root and a memory bound", () => {
    expect(vector.cap_drop).toEqual(["ALL"]);
    expect(vector.read_only).toBe(true);
    expect((vector as { mem_limit?: string }).mem_limit).toBe("64m");
    expect((vector as { user?: string }).user).toBe("10001:10001");
  });

  test("the local copy is capped at 2 x 5 MB and nothing else is kept", () => {
    expect(vector.logging).toEqual({ driver: "json-file", options: { "max-size": "5m", "max-file": "2" } });
    expect(vector.volumes).toBeUndefined();
    expect(JSON.stringify(vector)).not.toContain("tmpfs:/var/log");
  });

  test("both embedded configs are exactly what the builder produces; the ship part carries the secret reference and the host variable only", () => {
    const baseEmbedded = vector.environment!.VECTOR_CONFIG_JSON!;
    const shipEmbedded = vector.environment!.VECTOR_SHIP_JSON!;
    for (const embedded of [baseEmbedded, shipEmbedded]) expect(embedded.replaceAll("$$", "")).not.toContain("$");
    const parts = build.buildParts();
    expect(build.parseComposeEmbed(baseEmbedded)).toEqual(parts.base);
    expect(build.parseComposeEmbed(shipEmbedded)).toEqual(parts.ship);
    const ship = build.parseComposeEmbed(shipEmbedded) as { secret: unknown; sinks: { betterstack: { uri: string; auth: { token: string } } } };
    expect(ship.sinks.betterstack.auth.token).toBe("SECRET[bs.bs_token]");
    expect(ship.secret).toEqual({ bs: { type: "directory", path: "/var/lib/vector/secrets", remove_trailing_whitespace: true } });
    expect(ship.sinks.betterstack.uri).toBe("https://__INGEST_HOST__/");
    expect(JSON.stringify(parts)).not.toMatch(/Bearer [A-Za-z0-9]|betterstackdata/);
    // Local-only mode needs no secret and no HTTP sink.
    const base = parts.base as { secret?: unknown; sinks: Record<string, { type: string }> };
    expect(base.secret).toBeUndefined();
    expect(Object.keys(base.sinks)).toEqual(["local"]);
    expect(base.sinks.local!.type).toBe("console");
  });

  test("every sink, local or shipped, takes only the filtered stream and the content-free gate counts, never a raw stage", () => {
    const { base, ship } = build.buildParts() as { base: { transforms: Record<string, { inputs: string[] }>; sinks: Record<string, { inputs: string[] }> }; ship: { sinks: Record<string, { inputs: string[] }> } };
    const sinks = { ...base.sinks, ...ship.sinks };
    expect(Object.keys(sinks).sort()).toEqual(["betterstack", "local"]);
    const ancestors = (name: string, seen = new Set<string>()): Set<string> => {
      const stage = name.split(".")[0]!;
      if (seen.has(stage)) return seen;
      seen.add(stage);
      for (const input of base.transforms[stage]?.inputs ?? []) ancestors(input, seen);
      return seen;
    };
    expect(sinks.local!.inputs).toEqual(["local_clean"]);
    expect(sinks.betterstack!.inputs).toEqual(["ship_clean"]);
    expect(build.SINK_INPUTS).toEqual({ local: ["local_clean"], betterstack: ["ship_clean"] });
    for (const [name, sink] of Object.entries(sinks)) {
      const reached = new Set(sink.inputs.flatMap((input) => [...ancestors(input)]));
      // Both sinks sit behind the budget, the cap, the guard and the allow-list; the counts come from the content-free gate counter.
      for (const stage of ["budget", "cap", "guard", "allowlist", "gate_counts"]) expect(reached.has(stage), `${name} <- ${stage}`).toBe(true);
      for (const raw of ["gelf_in", "gelf_envelope", "logship_gate", "gate_route"]) expect(sink.inputs, name).not.toContain(raw);
    }
    expect(base.transforms.budget!.inputs).toEqual(["cap", "gate_output"]);
    expect(base.transforms.ship_clean!.inputs).toEqual(["budget_route.ship"]);
    expect(base.transforms.local_clean!.inputs).toEqual(["budget_route.ship", "budget_route._unmatched"]);
    expect((base.transforms.budget_route as unknown as { route: Record<string, string> }).route).toEqual({ ship: "._ship == true" });
    expect(base.transforms.cap!.inputs).toEqual(["guard"]);
    expect(base.transforms.guard!.inputs).toEqual(["allowlist"]);
    expect(base.transforms.gate_output!.inputs).toEqual(["gate_reduce"]);
    expect(base.transforms.gate_reduce!.inputs).toEqual(["gate_counts"]);
  });
});

describe("deploy workflow carries the log shipping settings (TC-1978)", () => {
  test("environment secret -> PHALA_ENV_BETTERSTACK_SOURCE_TOKEN -> sealed env BETTERSTACK_SOURCE_TOKEN", () => {
    expect(deployStep.env?.PHALA_ENV_BETTERSTACK_SOURCE_TOKEN).toBe("${{ secrets.BETTERSTACK_SOURCE_TOKEN }}");
    expect(deployStep.run).toContain(`printf '%s\\n' "BETTERSTACK_SOURCE_TOKEN=\${PHALA_ENV_BETTERSTACK_SOURCE_TOKEN:-}"`);
    expect(workflow.jobs.deploy.environment).toEqual({ name: "production-api", url: expect.any(String) });
    expect(workflowText).not.toMatch(/PROD_\w*BETTERSTACK/);
    expect(read("docker-compose.phala.yml")).not.toMatch(/PROD_\w*BETTERSTACK/);
  });

  test("repo variable -> PHALA_ENV_BETTERSTACK_INGEST_HOST -> sealed env BETTERSTACK_INGEST_HOST, validated before it is written", () => {
    expect(deployStep.env?.PHALA_ENV_BETTERSTACK_INGEST_HOST).toBe("${{ vars.TINYCHAT_BETTERSTACK_INGEST_HOST }}");
    expect(deployStep.run).toContain(`printf '%s\\n' "BETTERSTACK_INGEST_HOST=\${PHALA_ENV_BETTERSTACK_INGEST_HOST:-}"`);
    expect(deployStep.run).toContain("must be a *.betterstackdata.com hostname");
    expect(deployStep.run!.indexOf("must be a *.betterstackdata.com hostname")).toBeLessThan(deployStep.run!.indexOf('} > "$ENV_FILE"'));
  });

  test("repo variables -> PHALA_ENV_ -> sealed envs for the two volume limits, validated before they are written, bad values ignored", () => {
    expect(deployStep.env?.PHALA_ENV_BETTERSTACK_DAILY_BYTE_BUDGET).toBe("${{ vars.TINYCHAT_BETTERSTACK_DAILY_BYTE_BUDGET }}");
    expect(deployStep.env?.PHALA_ENV_BETTERSTACK_MAX_LINES_PER_MINUTE).toBe("${{ vars.TINYCHAT_BETTERSTACK_MAX_LINES_PER_MINUTE }}");
    expect(deployStep.run).toContain(`printf '%s\\n' "BETTERSTACK_DAILY_BYTE_BUDGET=$log_budget"`);
    expect(deployStep.run).toContain(`printf '%s\\n' "BETTERSTACK_MAX_LINES_PER_MINUTE=$log_lines"`);
    expect(deployStep.run).toContain("^[1-9][0-9]{0,11}$");
    expect(deployStep.run).toContain("^[1-9][0-9]{0,8}$");
    // A bad value is a warning and the default applies; it never fails the deploy.
    expect(deployStep.run).toContain('log_budget=""');
    expect(deployStep.run).toContain('log_lines=""');
    const ignored = deployStep.run!.indexOf("Ignored log shipping limit");
    expect(deployStep.run!.slice(ignored, ignored + 200)).not.toContain("exit 1");
  });

  test("allowed_envs is derived from the env file's keys, and both keys are always among them, even with the secret and variable unset", () => {
    // phala-sync-allowed-envs.mjs takes every KEY of the file the deploy step writes; the keys are written unconditionally.
    const keys = [...deployStep.run!.matchAll(/printf '%s\\n' "([A-Z0-9_]+)=/g)].map((match) => match[1]);
    expect(keys).toContain("BETTERSTACK_SOURCE_TOKEN");
    expect(keys).toContain("BETTERSTACK_INGEST_HOST");
    expect(new Set(keys).size).toBe(keys.length);
    for (const name of ["BETTERSTACK_SOURCE_TOKEN=", "BETTERSTACK_INGEST_HOST="]) {
      const line = deployStep.run!.split("\n").find((candidate) => candidate.includes(`"${name}`))!;
      expect(line).not.toMatch(/\bif\b|&&|\|\|/);
    }
    // The sync is add-only: the union of the CVM's current allowed_envs and the file's keys.
    const sync = read(".github/scripts/phala-sync-allowed-envs.mjs");
    expect(sync).toContain("new Set([...allowed, ...envKeys])");
    expect(sync).not.toMatch(/\ballowed\.delete|filter\(\(k\) => envKeys/);
  });

  test("a missing secret or variable never fails the deploy; a multi-line token or a bad host does, without printing the token", () => {
    const check = workflow.jobs.deploy.steps.find((step) => step.name === "Check deployment configuration")!;
    expect(check.run).not.toContain("BETTERSTACK");
    expect(deployStep.run).toContain("must be a single-line value");
    const guard = deployStep.run!.split("\n").filter((candidate) => candidate.includes("BETTERSTACK"));
    for (const candidate of guard.filter((entry) => /\becho\b/.test(entry))) {
      expect(candidate).not.toMatch(/\$\{?PHALA_ENV_BETTERSTACK_SOURCE/);
    }
  });

  test("the token value is never printed, traced or echoed anywhere in the workflow", () => {
    const lines = workflowText.split("\n").filter((line) => line.includes("BETTERSTACK"));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).not.toMatch(/set -x|\becho\b[^"]*\$\{?PHALA_ENV_BETTERSTACK_SOURCE|\bcat\b/);
    }
    expect(workflowText).not.toMatch(/secrets\.BETTERSTACK_SOURCE_TOKEN[^\n]*(echo|>>)/);
  });
});

describe("log shipper schema (TC-1978)", () => {
  const classes = build.keyClasses();
  const structural = new Set(build.STRUCTURAL);

  test("every registered fixed message maps to a declared component and event code", () => {
    const codes = new Set<string>(schema.fields.event_code.values);
    const components = new Set<string>(schema.fields.component.values);
    for (const entry of registry) {
      expect(codes.has(entry.code), entry.code).toBe(true);
      expect(components.has(entry.component), entry.component).toBe(true);
      expect(["info", "warn", "error"]).toContain(entry.level);
    }
    expect(new Set(registry.map((entry) => entry.code)).size).toBe(registry.length);
    expect(new Set(registry.map((entry) => entry.text)).size).toBe(registry.length);
  });

  test("the declared events are exactly the five the shipper can emit, and typed attributes never collide with structural keys", () => {
    expect(schema.events).toEqual(["backend_log", "logship_gate_summary_total", "log_dropped", "log_stream_dropped", "daily_budget_reached"]);
    for (const key of [...classes.code, ...classes.int, ...classes.bool, ...Object.keys(classes.enum)]) {
      if (structural.has(key)) continue;
      expect(["svc", "level", "ts", "event", "component", "event_code"]).not.toContain(key);
    }
    // Typed attribute names are shipped verbatim as column names: only lowercase snake case.
    for (const key of Object.keys(schema.fields)) expect(key).toMatch(/^[a-z][a-z0-9_]{0,40}$/);
    // The one numeric status is bounded to HTTP; free-form keys do not exist.
    expect(schema.fields.status).toEqual({ type: "integer", min: 100, max: 599 });
    for (const key of classes.code) expect(schema.fields[key].regex).toBe("^[a-z][a-z0-9_-]{0,47}$");
  });

  test("no shipped attribute can carry an identifier: keys named for ids, addresses, text or tokens are not declared", () => {
    const forbidden = /(^|_)(id|ids|address|addr|did|token|secret|key|email|url|uri|message|msg|text|body|name|error|err|path|aid|mid|tid|sig|cid|account|user)(_|$)/;
    const declared = Object.keys(schema.fields).filter((key) => forbidden.test(key) && !["event_code", "error_class"].includes(key));
    expect(declared).toEqual([]);
  });
});

describe("volume limits (TC-1978)", () => {
  const defaults = { budget: build.DEFAULT_DAILY_BYTE_BUDGET as number, lines: build.DEFAULT_MAX_LINES_PER_MINUTE as number };

  // Runs the compose entrypoint for real, with `vector` replaced by a stub that only records its arguments.
  function runEntrypoint(env: Record<string, string>) {
    const dir = mkdtempSync(join(scratch, "ep-"));
    const state = join(dir, "vec");
    mkdirSync(state);
    mkdirSync(join(dir, "bin"));
    writeFileSync(join(dir, "bin", "vector"), '#!/bin/sh\nfor a in "$@"; do printf "%s\\n" "$a"; done\n');
    chmodSync(join(dir, "bin", "vector"), 0o755);
    const script = vector.entrypoint!.at(-1)!.replaceAll("$$", "$").replaceAll("/var/lib/vector", state);
    const result = spawnSync("/bin/sh", ["-ec", script], {
      env: { PATH: `${join(dir, "bin")}:/usr/bin:/bin`, VECTOR_CONFIG_JSON: vector.environment!.VECTOR_CONFIG_JSON!.replaceAll("$$", "$"), VECTOR_SHIP_JSON: vector.environment!.VECTOR_SHIP_JSON!.replaceAll("$$", "$"), ...env },
      encoding: "utf8",
    });
    const runtime = JSON.parse(readFileSync(join(state, "runtime.json"), "utf8")) as { transforms: { budget: { source: string }; cap: { source: string } } };
    return {
      status: result.status,
      stdout: result.stdout,
      budget: Number(/local daily_budget = (\d+)/.exec(runtime.transforms.budget.source)![1]),
      lines: Number(/local max_lines = (\d+)/.exec(runtime.transforms.cap.source)![1]),
    };
  }

  test("the shell is pinned to `sh -ec`: no trace flag could echo the environment into the kept local log", () => {
    expect(vector.entrypoint!.slice(0, 2)).toEqual(["/bin/sh", "-ec"]);
    const script = vector.entrypoint!.at(-1)!;
    expect(script).not.toMatch(/\bset\s+-[a-zA-Z]*[xv]|xtrace|\bsh\s+-[a-z]*x/);
  });

  test("with neither limit set the baked-in defaults apply, and their numbers live only in limits.mjs", () => {
    const run = runEntrypoint({});
    expect(run.status).toBe(0);
    expect({ budget: run.budget, lines: run.lines }).toEqual({ budget: defaults.budget, lines: defaults.lines });
    const script = vector.entrypoint!.at(-1)!;
    expect(script).not.toContain(String(defaults.budget));
    expect(script).not.toMatch(new RegExp(`\\b${defaults.lines}\\b`));
    expect(defaults.budget).toBe(20_000_000);
  });

  test("a valid positive integer replaces a limit: the budget up to its 200 MB/day ceiling, lines up to 9 digits", () => {
    expect(runEntrypoint({ BETTERSTACK_DAILY_BYTE_BUDGET: "50000000", BETTERSTACK_MAX_LINES_PER_MINUTE: "600" })).toMatchObject({ budget: 50_000_000, lines: 600 });
    expect(runEntrypoint({ BETTERSTACK_DAILY_BYTE_BUDGET: String(MAX_DAILY_BYTE_BUDGET), BETTERSTACK_MAX_LINES_PER_MINUTE: "999999999" })).toMatchObject({ budget: MAX_DAILY_BYTE_BUDGET, lines: 999_999_999 });
    expect(runEntrypoint({ BETTERSTACK_DAILY_BYTE_BUDGET: "1" })).toMatchObject({ budget: 1, lines: defaults.lines });
  });

  test("the budget variable cannot raise the ceiling: above 200 MB/day the default applies (never clamped to the ceiling)", () => {
    expect(MAX_DAILY_BYTE_BUDGET).toBe(200_000_000);
    for (const value of [String(MAX_DAILY_BYTE_BUDGET + 1), "300000000", "1000000000", "999999999999"]) {
      expect(runEntrypoint({ BETTERSTACK_DAILY_BYTE_BUDGET: value }).budget, value).toBe(defaults.budget);
    }
    // The ceiling is baked into the config next to the budget, and is the only place its number lives besides the workflow pin.
    expect(vector.entrypoint!.at(-1)!).not.toContain(String(MAX_DAILY_BYTE_BUDGET));
    expect(JSON.stringify(build.buildParts().base)).toContain(`local max_daily_budget = ${MAX_DAILY_BYTE_BUDGET}`);
    // The workflow validates the same ceiling before the value is written.
    expect(deployStep.run).toContain(`-gt ${MAX_DAILY_BYTE_BUDGET}`);
  });

  test("the whole-stream cap is a true ceiling: at most max_lines + 10 per-key lines + 1 stream line (+ 7 gate summaries) per window", () => {
    expect(MAX_DROPPED_LINES).toBe(10);
    expect(lineCeiling(defaults.lines)).toBe(defaults.lines + 10 + 1 + 7);
    const cap = JSON.stringify(build.buildParts().base);
    expect(cap).toContain(`local max_drop_lines = ${MAX_DROPPED_LINES}`);
  });

  test("any bad value falls back to the default: signs, zero, leading zeros, decimals, exponents, text, spaces, newlines, too many digits, sed syntax", () => {
    const bad = ["0", "00", "007", "-5", "+5", "1.5", "1e9", "abc", " 12", "12 ", "5\n6", "", "1234567890123", "1/;s/x/y/", "1;rm", "$(id)", "`id`", "99999999999999999999"];
    for (const value of bad) {
      const run = runEntrypoint({ BETTERSTACK_DAILY_BYTE_BUDGET: value, BETTERSTACK_MAX_LINES_PER_MINUTE: value });
      expect(run.status, JSON.stringify(value)).toBe(0);
      expect({ budget: run.budget, lines: run.lines }, JSON.stringify(value)).toEqual({ budget: defaults.budget, lines: defaults.lines });
    }
    // 10 digits is too many for lines, while the same call keeps a valid budget.
    expect(runEntrypoint({ BETTERSTACK_DAILY_BYTE_BUDGET: "150000000", BETTERSTACK_MAX_LINES_PER_MINUTE: "1234567890" })).toMatchObject({ budget: 150_000_000, lines: defaults.lines });
  });

  test("limits do not depend on the token or the host: local-only mode still applies them, and ship.json is loaded only with both", () => {
    const local = runEntrypoint({ BETTERSTACK_DAILY_BYTE_BUDGET: "7000000" });
    expect(local.budget).toBe(7_000_000);
    expect(local.stdout).not.toContain("ship.json");
    const shipping = runEntrypoint({ BETTERSTACK_SOURCE_TOKEN: "synthetic", BETTERSTACK_INGEST_HOST: "s1.us-west-2a.betterstackdata.com", BETTERSTACK_DAILY_BYTE_BUDGET: "7000000" });
    expect(shipping.stdout).toContain("ship.json");
    expect(shipping.budget).toBe(7_000_000);
  });

  test("the budget estimate never under-counts the JSON the sink sends", () => {
    const samples: Record<string, string | number | boolean>[] = [
      { ts: "2026-10-24T00:00:00.000Z", level: "warn", event: "logship_gate_summary_total", svc: "logship", gate_reason: "oversized", count: 3 },
      { ts: "2026-10-24T00:00:00.000Z", level: "info", event: "backend_log", svc: "backend", component: "transcript-delivery", event_code: "structured", op: "deliver", result: "written", ms: 12, alert: true },
      { ts: "2026-10-24T00:00:00.000Z", level: "error", event: "backend_log", svc: "backend", component: "process", event_code: "error_line", error_class: "TypeError" },
      { ts: "2026-10-24T00:00:00.000Z", level: "warn", event: "log_dropped", svc: "backend", component: "chat", event_code: "structured", dropped: 9007199254740991, window_s: 60 },
      { ts: "2026-10-24T00:00:00.000Z", level: "warn", event: "daily_budget_reached", svc: "logship", budget_bytes: 20000000 },
    ];
    for (const sample of samples) expect(estimateBytes(sample)).toBeGreaterThanOrEqual(Buffer.byteLength(`${JSON.stringify(sample)}\n`));
  });

  test("the scan recognises all three interpolation shapes: key=${expr}, a concatenated \"key=\" + expr, and a dynamic ${name}=${expr}", () => {
    const dir = mkdtempSync(join(scratch, "scan-"));
    writeFileSync(join(dir, "sites.ts"), [
      "console.log(`[x] op=${userId} result=ok`);",
      'console.log("[x] result=" + user.name);',
      "console.log('[x] reason=' + a + ' code=' + b);",
      "console.log(`[x] ${key}=${value}`);",
      "console.log(`[x] op=deliver ms=${elapsed}`);",
    ].join("\n"));
    const found = (scanCallSites(dir) as string[]).map((entry) => entry.split("|").slice(1).join("|"));
    expect(found).toEqual(expect.arrayContaining(["op|userId", "result|+ user.name", "reason|+ a", "code|+ b", "${key}|value", "ms|elapsed"]));
    expect(found).not.toContain("op|deliver");
  });

  test("the reviewed list of shape-checked call sites is complete: a new key=${expression} in backend/src fails until it is reviewed", () => {
    // The sink checks code and integer values by shape. A call site that interpolates an identifier or a name into one of those
    // keys would ship it when it has the right shape, so every such interpolation is listed, reviewed and frozen here. To add
    // one: review the expression, then `node log-shipper/scan.mjs --write`.
    const reviewed = new Set<string>(reviewedCallSites());
    const unreviewed = (scanCallSites() as string[]).filter((entry) => !reviewed.has(entry));
    expect(unreviewed).toEqual([]);
  });
});
