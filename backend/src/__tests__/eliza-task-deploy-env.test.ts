import { describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { load } from "js-yaml";

const root = resolve(import.meta.dir, "../../..");
type Step = { name?: string; env?: Record<string, string>; run?: string };
const workflow = load(readFileSync(resolve(root, ".github/workflows/deploy-backend-phala.yml"), "utf8")) as {
  jobs: { deploy: { steps: Step[] } };
};
const deploy = workflow.jobs.deploy.steps.find(step => step.name === "Deploy to Phala Cloud")!;
const sync = workflow.jobs.deploy.steps.find(step => step.name === "Sync CVM allowed_envs")!;
const compose = load(readFileSync(resolve(root, "docker-compose.phala.yml"), "utf8")) as {
  services: Record<string, { environment: Record<string, string> }>;
};

function writeDeployEnv(temp: string, settings: Record<string, string>) {
  // Execute the checked-in writer only, stopping before any deploy or credential logging.
  const writer = deploy.run!.split('echo "::group::Deploy environment keys"')[0]!;
  const result = Bun.spawnSync(["/bin/bash", "-c", writer], {
    cwd: temp,
    env: { RUNNER_TEMP: temp, ...settings },
  });
  expect(result.exitCode).toBe(0);
  return readFileSync(resolve(temp, "phala-prod.env"), "utf8");
}

describe("Eliza task deployment environment", () => {
  test.each([
    ["ELIZA_TASKS_ENABLED", "${{ vars.ELIZA_TASKS_ENABLED || 'false' }}", "false"],
    ["ELIZA_TASKS_TEST_ACCOUNTS", "${{ vars.ELIZA_TASKS_TEST_ACCOUNTS }}", ""],
  ])("declares %s with its inactive default in workflow, compose and example", (key, expression, fallback) => {
    expect(deploy.env?.[key]).toBe(expression);
    expect(compose.services["tinychat-backend"]!.environment[key]).toBe(`\${${key}:-${fallback}}`);
    const example = readFileSync(resolve(root, "backend/.env.example"), "utf8");
    expect([...example.matchAll(new RegExp(`^${key}=(.*)$`, "gm"))].map(match => match[1])).toEqual([fallback]);
  });

  test.each([
    [{}, "false", ""],
    [{ ELIZA_TASKS_ENABLED: "true", ELIZA_TASKS_TEST_ACCOUNTS: "0xAbC, 0xdef" }, "true", "0xAbC, 0xdef"],
  ])("writes task settings unchanged into the same file deployed and synced", (settings, enabled, accounts) => {
    const temp = mkdtempSync(resolve(tmpdir(), "tinychat-task-env-"));
    try {
      const env = writeDeployEnv(temp, settings);
      expect(env).toContain(`ELIZA_TASKS_ENABLED=${enabled}\n`);
      expect(env).toContain(`ELIZA_TASKS_TEST_ACCOUNTS=${accounts}\n`);
      expect(deploy.run).toContain('-e "$ENV_FILE"');
      expect(sync.env?.ENV_FILE).toBe("${{ runner.temp }}/phala-prod.env");
      expect(sync.run).toContain("node phala-sync-allowed-envs.mjs");
      for (const key of ["VITE_LOCAL_VALIDATION", "TINYCHAT_LOCAL_VALIDATION", "ELIZA_LOCAL_VALIDATION"]) {
        expect(env).not.toContain(`${key}=`);
        expect(compose.services["tinychat-backend"]!.environment).not.toHaveProperty(key);
      }
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  test("sync encrypts the complete deploy file and adds task names without dropping existing allowed names", () => {
    const temp = mkdtempSync(resolve(tmpdir(), "tinychat-task-sync-"));
    try {
      const env = writeDeployEnv(temp, {
        ELIZA_TASKS_ENABLED: "true",
        ELIZA_TASKS_TEST_ACCOUNTS: "0xAbC, 0xdef",
        ELIZA_SERVICE_SECRET: "synthetic-service-credential=with-padding",
        CONNECTOR_CREDENTIAL_MASTER: "synthetic-existing-custody-value",
      });
      const packageDir = resolve(temp, "node_modules/@phala/cloud");
      mkdirSync(packageDir, { recursive: true });
      writeFileSync(resolve(packageDir, "package.json"), JSON.stringify({ type: "module", main: "index.mjs" }));
      // Stub only the remote boundary. The original sync script runs in a fresh process,
      // so no production credentials, network calls or module mocks reach other tests.
      writeFileSync(resolve(packageDir, "index.mjs"), `
        import { writeFileSync } from "node:fs";
        const receipt = { encrypted: null, updates: [] };
        let infoCalls = 0;
        const save = () => writeFileSync(process.env.RECEIPT_FILE, JSON.stringify(receipt));
        globalThis.setTimeout = callback => { queueMicrotask(callback); return 0; };
        export const createClient = () => ({});
        export const getCvmInfo = async () => ({ encrypted_env_pubkey: "synthetic-public-key", status: ++infoCalls === 2 ? "restarting" : "running" });
        export const getCvmComposeFile = async () => ({ allowed_envs: receipt.updates.at(-1)?.env_keys ?? ["LEGACY_ONLY_SETTING", "ELIZA_SERVICE_SECRET"] });
        export const encryptEnvVars = async envs => { receipt.encrypted = envs; save(); return "synthetic-encrypted-env"; };
        export const updateCvmEnvs = async (_, input) => {
          receipt.updates.push(input); save();
          return input.compose_hash ? { status: "in_progress", correlation_id: "synthetic-update", allowed_envs_changed: true }
            : { status: "precondition_required", compose_hash: "synthetic-compose-hash" };
        };
      `);
      copyFileSync(resolve(root, ".github/scripts/phala-sync-allowed-envs.mjs"), resolve(temp, "sync.mjs"));
      const result = Bun.spawnSync([process.execPath, "--no-env-file", resolve(temp, "sync.mjs")], {
        cwd: temp,
        env: {
          PHALA_CLOUD_API_KEY: "synthetic-api-key",
          PHALA_CVM_ID: "synthetic-cvm",
          ENV_FILE: resolve(temp, "phala-prod.env"),
          RECEIPT_FILE: resolve(temp, "receipt.json"),
        },
      });
      expect(result.exitCode).toBe(0);
      const receipt = JSON.parse(readFileSync(resolve(temp, "receipt.json"), "utf8"));
      const expected = env.trimEnd().split("\n").map(line => {
        const separator = line.indexOf("=");
        return { key: line.slice(0, separator), value: line.slice(separator + 1) };
      });
      expect(receipt.encrypted).toEqual(expected);
      expect(receipt.updates).toHaveLength(2);
      for (const update of receipt.updates) {
        expect(update.env_keys).toContain("LEGACY_ONLY_SETTING");
        expect(update.env_keys).toContain("ELIZA_TASKS_ENABLED");
        expect(update.env_keys).toContain("ELIZA_TASKS_TEST_ACCOUNTS");
        expect(new Set(update.env_keys).size).toBe(update.env_keys.length);
        expect(update.encrypted_env).toBe("synthetic-encrypted-env");
      }
      expect(receipt.updates[1].compose_hash).toBe("synthetic-compose-hash");
      const output = result.stdout.toString() + result.stderr.toString();
      expect(output).not.toContain("synthetic-service-credential");
      expect(output).not.toContain("synthetic-existing-custody-value");
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });
});
