import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { load as loadYaml } from "js-yaml";
import * as build from "../../../log-shipper/build.mjs";

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
    for (const [name, sink] of Object.entries(sinks)) {
      expect(sink.inputs, name).toEqual(["cap", "gate_output"]);
      expect(sink.inputs, name).toEqual(build.SINK_INPUTS);
      const reached = new Set(sink.inputs.flatMap((input) => [...ancestors(input)]));
      // The filtered stream passes the allow-list and the guard; the counts come from the content-free gate counter.
      expect(reached.has("allowlist"), name).toBe(true);
      expect(reached.has("guard"), name).toBe(true);
      expect(reached.has("gate_counts"), name).toBe(true);
    }
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

  test("the declared events are exactly the three the shipper can emit, and typed attributes never collide with structural keys", () => {
    expect(schema.events).toEqual(["backend_log", "logship_gate_summary_total", "log_dropped"]);
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
