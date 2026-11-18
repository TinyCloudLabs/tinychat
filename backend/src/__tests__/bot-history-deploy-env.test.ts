import { expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { load } from "js-yaml";
import { supervisorConfig } from "../../../bots/src/config";

const root = resolve(import.meta.dir, "../../..");
const keys = ["BOTS_HISTORY_ENABLED", "BOTS_HISTORY_SIGNER_DID", "BOTS_HISTORY_NODE_ORIGIN", "BOTS_UNARCHIVED_HISTORY_POLICY"];
const values = { BOTS_HISTORY_ENABLED: "true", BOTS_HISTORY_SIGNER_DID: "did:pkh:eip155:1:0x" + "11".repeat(20),
  BOTS_HISTORY_NODE_ORIGIN: "https://node.example", BOTS_UNARCHIVED_HISTORY_POLICY: "notice-then-expiry-30-days" };
type Step = { name: string; env?: Record<string, string>; run?: string };
type Workflow = { jobs: { deploy: { environment: { name: string }; steps: Step[] } } };
type Compose = { services: Record<string, { environment: Record<string, string> }> };
const read = (file: string) => readFileSync(resolve(root, file), "utf8");
const workflow = (lane: string) => load(read(`.github/workflows/deploy-${lane}-phala.yml`)) as Workflow;
const writer = (lane: string) => workflow(lane).jobs.deploy.steps.find(step => step.name === "Deploy to Phala Cloud")!;
function writeEnv(lane: string, temp: string, settings: Record<string, string>) {
  const script = writer(lane).run!.split('echo "::group::Deploy environment keys"')[0]!;
  const path = resolve(temp, "phala-prod.env");
  const env = { HOME: process.env.HOME, TC_HOME: process.env.TC_HOME, RUNNER_TEMP: temp, ENV_FILE: path,
    BOTS_HISTORY_ENABLED: "false", BOTS_SERVICE_SECRET: "s".repeat(64), BOTS_REDPILL_API_KEY: "fixture", CLOUDFLARE_API_TOKEN: "fixture", CERTBOT_EMAIL: "fixture@example.com",
    BOTS_INGRESS_DOMAIN: "bots.example.com", PHALA_GATEWAY_CNAME: "fixture.example.com", ...settings };
  const result = Bun.spawnSync(["/bin/bash", "-c", script], { cwd: temp, env });
  return { result, path };
}
for (const lane of ["backend", "bots"]) {
  test(`${lane} history variables reach the env file and container, with history off by default`, () => {
    const config = workflow(lane);
    expect(config.jobs.deploy.environment.name).toBe(lane === "backend" ? "production-api" : "production-bots");
    const compose = load(read(lane === "backend" ? "docker-compose.phala.yml" : "bots/docker-compose.phala.yml")) as Compose;
    const environment = compose.services[lane === "backend" ? "tinychat-backend" : "bots-supervisor"]!.environment;
    const temp = mkdtempSync(resolve(tmpdir(), "bot-history-env-"));
    try {
      for (const key of keys) {
        expect(writer(lane).env?.[key]).toBe(`\${{ vars.${key}${key === keys[0] ? " || 'false'" : ""} }}`);
        const fallback = key === keys[0] ? "false" : key === keys[3] ? "notice-then-expiry-30-days" : "";
        expect(environment[key]).toBe(`\${${key}:-${fallback}}`);
      }
      const defaults = writeEnv(lane, temp, {});
      expect(defaults.result.exitCode).toBe(0);
      const off = readFileSync(defaults.path, "utf8");
      for (const key of keys) expect(off).toContain(`${key}=${key === keys[0] ? "false" : ""}\n`);
      expect(writeEnv(lane, temp, values).result.exitCode).toBe(0);
      const enabled = readFileSync(defaults.path, "utf8");
      for (const [key, value] of Object.entries(values)) expect(enabled).toContain(`${key}=${value}\n`);
      if (lane === "bots") expect(compose.services["bots-gateway"]!.environment.BOTS_HISTORY_ENABLED).toBe("${BOTS_HISTORY_ENABLED:-false}");
      for (const key of keys) for (const newline of ["\n", "\r"]) {
        expect(writeEnv(lane, temp, { [key]: `value${newline}INJECTED=1` }).result.exitCode).not.toBe(0);
      }
    } finally { rmSync(temp, { recursive: true, force: true }); }
  });
}
test("enabling supervisor history still fails closed without receipt pins or with an invalid policy", () => {
  const base = { BOTS_SERVICE_SECRET: "s".repeat(64) };
  expect(supervisorConfig(base).history).toBeUndefined();
  for (const key of ["BOTS_HISTORY_SIGNER_DID", "BOTS_HISTORY_NODE_ORIGIN"]) {
    expect(() => supervisorConfig({ ...base, ...values, [key]: "" })).toThrow(key);
  }
  expect(() => supervisorConfig({ ...base, ...values, BOTS_UNARCHIVED_HISTORY_POLICY: "" })).toThrow("BOTS_UNARCHIVED_HISTORY_POLICY");
  expect(supervisorConfig({ ...base, ...values }).history).toEqual({ signerDid: values.BOTS_HISTORY_SIGNER_DID, host: values.BOTS_HISTORY_NODE_ORIGIN, policy: values.BOTS_UNARCHIVED_HISTORY_POLICY });
});
test("the actual bots allowed_envs sync registers all four names even while history is off", () => {
  const temp = mkdtempSync(resolve(tmpdir(), "bot-history-sync-"));
  try {
    const { result, path } = writeEnv("bots", temp, {});
    expect(result.exitCode).toBe(0);
    const packageDir = resolve(temp, "node_modules/@phala/cloud");
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(resolve(packageDir, "package.json"), JSON.stringify({ type: "module", main: "index.mjs" }));
    writeFileSync(resolve(packageDir, "index.mjs"), `
      import { writeFileSync } from "node:fs";
      let allowed = ["EXISTING_SETTING"];
      let calls = 0;
      globalThis.setTimeout = callback => { queueMicrotask(callback); return 0; };
      export const createClient = () => ({});
      export const getCvmInfo = async () => ({ encrypted_env_pubkey: "fixture", status: ++calls === 2 ? "restarting" : "running" });
      export const getCvmComposeFile = async () => ({ allowed_envs: allowed });
      export const encryptEnvVars = async () => "fixture";
      export const updateCvmEnvs = async (_, input) => {
        if (!input.compose_hash) return { status: "precondition_required", compose_hash: "fixture" };
        allowed = input.env_keys; writeFileSync(process.env.RESULT_FILE, JSON.stringify(allowed));
        return { status: "in_progress", correlation_id: "fixture", allowed_envs_changed: true };
      };
    `);
    copyFileSync(resolve(root, ".github/scripts/phala-sync-allowed-envs.mjs"), resolve(temp, "sync.mjs"));
    const sync = Bun.spawnSync([process.execPath, "--no-env-file", resolve(temp, "sync.mjs")], { cwd: temp,
      env: { HOME: process.env.HOME, TC_HOME: process.env.TC_HOME, PHALA_CLOUD_API_KEY: "fixture", PHALA_CVM_ID: "fixture", ENV_FILE: path, RESULT_FILE: resolve(temp, "keys.json") } });
    expect(sync.exitCode).toBe(0);
    const allowed = JSON.parse(readFileSync(resolve(temp, "keys.json"), "utf8"));
    expect(allowed).toContain("EXISTING_SETTING");
    for (const key of keys) expect(allowed).toContain(key);
    expect(workflow("bots").jobs.deploy.steps.find(step => step.name === "Sync CVM allowed_envs")?.run).toContain('PHALA_CVM_ID="$BOTS_PHALA_CVM_ID" node phala-sync-allowed-envs.mjs');
  } finally { rmSync(temp, { recursive: true, force: true }); }
});
