import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { load as loadYaml } from "js-yaml";

// TC-2136: the private log shipper (Vector sidecar -> Better Stack). These tests pin the properties that keep it
// private and keep it from touching the backend; the Vector behaviour cases live in log-shipper/vector.tests.yaml and
// run here when a vector binary is available (VECTOR_BIN or PATH) and always in CI through the pinned image.

const repoRoot = resolve(import.meta.dir, "../../..");
const composeText = readFileSync(resolve(repoRoot, "docker-compose.phala.yml"), "utf8");
const vectorText = readFileSync(resolve(repoRoot, "log-shipper/vector.yaml"), "utf8");
const workflowText = readFileSync(resolve(repoRoot, ".github/workflows/deploy-backend-phala.yml"), "utf8");

type Service = {
  image?: string;
  depends_on?: unknown;
  links?: unknown;
  network_mode?: string;
  environment?: Record<string, string>;
  labels?: Record<string, string>;
  logging?: { driver?: string; options?: Record<string, string> };
  ports?: Array<{ target: number; published: string; host_ip: string; protocol: string }>;
  entrypoint?: string[];
  command?: string[];
  restart?: string;
  volumes?: string[];
};
type Compose = { services: Record<string, Service> };
const compose = loadYaml(composeText) as Compose;
const shipper = compose.services["log-shipper"];
const backend = compose.services["tinychat-backend"];

type VectorConfig = {
  sources: Record<string, { address?: string }>;
  transforms: Record<string, { inputs: string[]; source: string }>;
  sinks: Record<string, { inputs: string[]; uri: string; auth: { token: string }; buffer: { when_full: string; type: string } }>;
};
const vector = loadYaml(vectorText) as VectorConfig;
const redactSource = vector.transforms.redact.source;

const tmpRoot = mkdtempSync(join("/var/tmp", "tc2136."));
afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));

describe("log-shipper sidecar in docker-compose.phala.yml", () => {
  test("exists with an image pinned by digest and a hardened runtime", () => {
    expect(shipper).toBeDefined();
    expect(shipper.image).toMatch(/^timberio\/vector:[0-9.]+-alpine@sha256:[0-9a-f]{64}$/);
    expect((shipper as Record<string, unknown>).read_only).toBe(true);
    expect((shipper as Record<string, unknown>).cap_drop).toEqual(["ALL"]);
    expect((shipper as Record<string, unknown>).security_opt).toEqual(["no-new-privileges:true"]);
    expect(shipper.restart).toBe("unless-stopped");
    // No docker socket, host path or named volume: it only listens on its own UDP port.
    expect(shipper.volumes).toBeUndefined();
    expect(JSON.stringify(shipper)).not.toContain("docker.sock");
  });

  test("runs independently: nothing depends on it and it depends on nothing", () => {
    expect(backend.depends_on).toBeUndefined();
    expect(shipper.depends_on).toBeUndefined();
    for (const [name, service] of Object.entries(compose.services)) {
      const deps = JSON.stringify(service.depends_on ?? null) + JSON.stringify(service.links ?? null);
      expect({ name, deps: deps.includes("log-shipper") }).toEqual({ name, deps: false });
      expect(service.network_mode ?? "").not.toContain("log-shipper");
    }
  });

  test("the backend reaches it only through a non-blocking GELF log driver on host loopback", () => {
    expect(backend.logging?.driver).toBe("gelf");
    expect(backend.logging?.options?.["gelf-address"]).toBe("udp://127.0.0.1:12201");
    expect(backend.logging?.options?.mode).toBe("non-blocking");
    expect(backend.logging?.options?.["max-buffer-size"]).toBeDefined();
    // Dual logging stays on, so the existing local log view is unchanged.
    expect(backend.logging?.options?.["cache-disabled"]).toBeUndefined();
    expect(shipper.ports).toEqual([{ target: 12201, published: "12201", host_ip: "127.0.0.1", protocol: "udp" }]);
    // The label the backend sets is exactly the one the gate accepts.
    expect(backend.labels?.["tc.logship"]).toBe("tinychat-backend");
    expect(backend.logging?.options?.labels).toBe("tc.logship");
    expect(redactSource).toContain('lbl != "tinychat-backend"');
  });

  test("the token is a reference, never a literal, and the sidecar is inert without it", () => {
    expect(shipper.environment?.BETTERSTACK_SOURCE_TOKEN).toBe("${BETTERSTACK_SOURCE_TOKEN:-}");
    expect(vector.sinks.betterstack.auth.token).toBe("SECRET[local_directory.betterstack_source_token]");
    for (const text of [composeText, vectorText]) {
      expect(text).not.toMatch(/Bearer\s+[A-Za-z0-9]/);
      expect(text).not.toMatch(/^\s*BETTERSTACK_SOURCE_TOKEN:\s*(?!["']?\$\{)\S/m);
    }
    const script = (shipper.command ?? []).join("\n");
    // Unset token: idle (exit 0 on TERM), never exit non-zero into a restart loop, never exec vector.
    const inert = script.slice(0, script.indexOf("printf"));
    expect(inert).toContain('[ -z "$${BETTERSTACK_SOURCE_TOKEN:-}" ]');
    expect(inert).toContain("while :; do sleep");
    expect(inert).not.toContain("exec vector");
    expect(inert).not.toMatch(/exit [1-9]/);
    // Set token: tmpfs file, then the variable is removed before vector starts.
    expect(script).toContain("> /run/vector-secrets/betterstack_source_token");
    expect(script.indexOf("unset BETTERSTACK_SOURCE_TOKEN")).toBeGreaterThan(script.indexOf("> /run/vector-secrets"));
    expect(script.indexOf("exec vector")).toBeGreaterThan(script.indexOf("unset VECTOR_CONFIG_YAML"));
  });

  test("the embedded config is exactly log-shipper/vector.yaml with every $ doubled", () => {
    const embedded = shipper.environment?.VECTOR_CONFIG_YAML;
    expect(embedded).toBeDefined();
    expect(embedded!.replaceAll("$$", "$")).toBe(vectorText);
    expect(embedded).not.toMatch(/(?<!\$)\$(?!\$)/);
  });
});

describe("deploy workflow carries the token like the other secrets", () => {
  test("step env, env file and compose reference the same name", () => {
    expect(workflowText).toContain("BETTERSTACK_SOURCE_TOKEN: ${{ secrets.BETTERSTACK_SOURCE_TOKEN }}");
    expect(workflowText).toContain("printf '%s\\n' \"BETTERSTACK_SOURCE_TOKEN=$BETTERSTACK_SOURCE_TOKEN\"");
    expect(workflowText).not.toMatch(/BETTERSTACK_SOURCE_TOKEN[:=]\s*[A-Za-z0-9]{8,}/);
    // The ingest host is fixed in vector.yaml (ptx-batch and node convention), not an env name.
    expect(vector.sinks.betterstack.uri).toBe("https://s2795438.us-west-2a.betterstackdata.com/");
    expect(workflowText).not.toContain("BETTERSTACK_INGEST_HOST");
  });
});


describe("Vector validates the config and passes its unit tests", () => {
  const vectorBin = process.env.VECTOR_BIN || Bun.which("vector");

  test.skipIf(!vectorBin)(
    "vector validate + vector test",
    async () => {
      const home = join(tmpRoot, "home");
      const secrets = join(tmpRoot, "secrets");
      mkdirSync(home, { recursive: true });
      mkdirSync(secrets, { recursive: true });
      expect(home.startsWith("/var/tmp/tc2136.")).toBe(true);
      writeFileSync(join(secrets, "betterstack_source_token"), "ci-placeholder");
      const config = join(tmpRoot, "vector.yaml");
      writeFileSync(config, vectorText.replace("path: /run/vector-secrets", `path: ${secrets}`));
      const env = { PATH: process.env.PATH ?? "", HOME: home, TC_HOME: home, VECTOR_LOG: "error" };
      const validate = Bun.spawn([vectorBin!, "validate", "--no-environment", "--skip-healthchecks", config], { env, stdout: "pipe", stderr: "pipe", timeout: 60_000 });
      const validateOut = (await new Response(validate.stdout).text()) + (await new Response(validate.stderr).text());
      expect(await validate.exited, validateOut).toBe(0);
      const tests = Bun.spawn([vectorBin!, "test", config, resolve(repoRoot, "log-shipper/vector.tests.yaml")], { env, stdout: "pipe", stderr: "pipe", timeout: 120_000 });
      const testOut = (await new Response(tests.stdout).text()) + (await new Response(tests.stderr).text());
      expect(await tests.exited, testOut).toBe(0);
      expect(testOut).not.toMatch(/\.\.\. failed/);
    },
    200_000,
  );

});
