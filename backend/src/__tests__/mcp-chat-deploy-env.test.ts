import { describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { load } from "js-yaml";

const root = resolve(import.meta.dir, "../../..");
interface Step { name?: string; env?: Record<string, string>; run?: string }
const workflow = load(readFileSync(resolve(root, ".github/workflows/deploy-backend-phala.yml"), "utf8")) as { jobs: { deploy: { steps: Step[] } } };
const deploy = workflow.jobs.deploy.steps.find(step => step.name === "Deploy to Phala Cloud")!;
const sync = workflow.jobs.deploy.steps.find(step => step.name === "Sync CVM allowed_envs")!;
const compose = load(readFileSync(resolve(root, "docker-compose.phala.yml"), "utf8")) as { services: Record<string, { environment: Record<string, string> }> };
const example = readFileSync(resolve(root, "backend/.env.example"), "utf8");

const SECRET = "synthetic-mcp-credential-with-enough-entropy=padding";
const KEYS = [
  "MCP_CHAT_ENABLED", "MCP_CHAT_TEST_ACCOUNTS", "MCP_CHAT_URL", "MCP_CHAT_SERVICE_DID", "MCP_CHAT_SERVICE_CREDENTIAL",
  "MCP_CHAT_SERVICE_CREDENTIAL_HEADER", "MCP_CHAT_OWNER_DID_HEADER", "MCP_CHAT_GRANT_EXPIRED_ERROR", "MCP_CHAT_GRANT_REJECTED_ERROR", "TAVILY_API_KEY",
];

function runWriter(temp: string, settings: Record<string, string>) {
  const writer = deploy.run!.split('echo "::group::Deploy environment keys"')[0]!;
  const result = Bun.spawnSync(["/bin/bash", "-c", writer], { cwd: temp, env: { RUNNER_TEMP: temp, ...settings } });
  return { exitCode: result.exitCode, output: result.stdout.toString() + result.stderr.toString() };
}
const readEnvFile = (temp: string) => readFileSync(resolve(temp, "phala-prod.env"), "utf8");

describe("MCP chat deployment environment", () => {
  test.each(KEYS)("%s reaches the backend container: declared in the workflow step, the compose file and the example", key => {
    expect(deploy.env).toHaveProperty(key);
    expect(compose.services["tinychat-backend"]!.environment).toHaveProperty(key);
    expect([...example.matchAll(new RegExp(`^${key}=`, "gm"))]).toHaveLength(1);
  });

  test("the credential comes from a repository secret, never a variable, and MCP chat stays off by default", () => {
    expect(deploy.env!.MCP_CHAT_SERVICE_CREDENTIAL).toBe("${{ secrets.MCP_CHAT_SERVICE_CREDENTIAL }}");
    expect(deploy.env!.TAVILY_API_KEY).toBe("${{ secrets.TAVILY_API_KEY }}");
    expect(deploy.env!.MCP_CHAT_ENABLED).toContain("'false'");
    const temp = mkdtempSync(resolve(tmpdir(), "tinychat-mcp-env-"));
    try {
      expect(runWriter(temp, {}).exitCode).toBe(0);
      expect(readEnvFile(temp)).toContain("MCP_CHAT_ENABLED=false\n");
      expect(readEnvFile(temp)).toContain("MCP_CHAT_SERVICE_CREDENTIAL=\n");
    } finally { rmSync(temp, { recursive: true, force: true }); }
  });

  test("writes the MCP settings unchanged into the one file that is deployed and synced, without echoing the credential", () => {
    const temp = mkdtempSync(resolve(tmpdir(), "tinychat-mcp-env-"));
    try {
      const settings = {
        MCP_CHAT_ENABLED: "true", MCP_CHAT_TEST_ACCOUNTS: "0xabc, 0xdef", MCP_CHAT_URL: "https://mcp.example/mcp", MCP_CHAT_SERVICE_DID: "did:key:z6MkExample",
        MCP_CHAT_SERVICE_CREDENTIAL: SECRET, MCP_CHAT_SERVICE_CREDENTIAL_HEADER: "X-Credential", MCP_CHAT_OWNER_DID_HEADER: "X-Owner",
        MCP_CHAT_GRANT_EXPIRED_ERROR: "expired_value", MCP_CHAT_GRANT_REJECTED_ERROR: "rejected_value", TAVILY_API_KEY: "tavily-synthetic",
      };
      const { exitCode, output } = runWriter(temp, settings);
      expect(exitCode).toBe(0);
      const file = readEnvFile(temp);
      for (const [key, value] of Object.entries(settings)) expect(file).toContain(`${key}=${value}\n`);
      expect(output).not.toContain(SECRET);
      expect(output).not.toContain("tavily-synthetic");
    } finally { rmSync(temp, { recursive: true, force: true }); }
  });

  test.each(["MCP_CHAT_SERVICE_CREDENTIAL", "MCP_CHAT_SERVICE_DID", "TAVILY_API_KEY", "MCP_CHAT_TEST_ACCOUNTS"])("rejects a %s containing a line break instead of letting it add environment lines", key => {
    for (const breaker of ["\n", "\r"]) {
      const temp = mkdtempSync(resolve(tmpdir(), "tinychat-mcp-env-"));
      try {
        const { exitCode, output } = runWriter(temp, { [key]: `value${breaker}INJECTED_SETTING=1` });
        expect(exitCode).not.toBe(0);
        expect(output).not.toContain("INJECTED_SETTING");
        expect(output).toContain(key);
      } finally { rmSync(temp, { recursive: true, force: true }); }
    }
  });

  test("the allowed_envs sync adds the MCP names and keeps the existing ones, and never prints the credential", () => {
    const temp = mkdtempSync(resolve(tmpdir(), "tinychat-mcp-sync-"));
    try {
      expect(runWriter(temp, { MCP_CHAT_SERVICE_CREDENTIAL: SECRET }).exitCode).toBe(0);
      const packageDir = resolve(temp, "node_modules/@phala/cloud");
      mkdirSync(packageDir, { recursive: true });
      writeFileSync(resolve(packageDir, "package.json"), JSON.stringify({ type: "module", main: "index.mjs" }));
      writeFileSync(resolve(packageDir, "index.mjs"), `
        import { writeFileSync } from "node:fs";
        const receipt = { encrypted: null, updates: [] };
        let infoCalls = 0;
        const save = () => writeFileSync(process.env.RECEIPT_FILE, JSON.stringify(receipt));
        globalThis.setTimeout = callback => { queueMicrotask(callback); return 0; };
        export const createClient = () => ({});
        export const getCvmInfo = async () => ({ encrypted_env_pubkey: "synthetic-public-key", status: ++infoCalls === 2 ? "restarting" : "running" });
        export const getCvmComposeFile = async () => ({ allowed_envs: receipt.updates.at(-1)?.env_keys ?? ["LEGACY_ONLY_SETTING"] });
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
        env: { PHALA_CLOUD_API_KEY: "synthetic-api-key", PHALA_CVM_ID: "synthetic-cvm", ENV_FILE: resolve(temp, "phala-prod.env"), RECEIPT_FILE: resolve(temp, "receipt.json") },
      });
      expect(result.exitCode).toBe(0);
      const receipt = JSON.parse(readFileSync(resolve(temp, "receipt.json"), "utf8"));
      for (const update of receipt.updates) {
        expect(update.env_keys).toContain("LEGACY_ONLY_SETTING");
        for (const key of KEYS) expect(update.env_keys).toContain(key);
      }
      expect(result.stdout.toString() + result.stderr.toString()).not.toContain(SECRET);
      expect(sync.env?.ENV_FILE).toBe("${{ runner.temp }}/phala-prod.env");
    } finally { rmSync(temp, { recursive: true, force: true }); }
  });
});
