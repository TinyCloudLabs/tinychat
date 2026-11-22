import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";

const REPO_ROOT = join(import.meta.dir, "../../..");
const SCRIPT = join(REPO_ROOT, "scripts/ops/backup-connector-master.sh");
const WORKFLOW = join(REPO_ROOT, ".github/workflows/backup-connector-master.yml");

const OWNER_DID = "did:pkh:eip155:1:0xAbCdEf0123456789aBcDeF0123456789AbCdEf01";
const OWNER_DID_LOWER = "did:pkh:eip155:1:0xabcdef0123456789abcdef0123456789abcdef01";
const WRONG_OWNER_DID = "did:pkh:eip155:1:0x9999999999999999999999999999999999999999";
const APPROVAL_URL = "https://openkey.so/a/req_abc12345#frag-token-xyz";
// Includes special characters to prove stdin preserves exact bytes without escaping or trimming.
const SECRET_VALUE = "cmk-super-secret-value-!@#$%^&*()-_+=\\\"'\\n\tXYZ987654321";
const SECRET_SHA256 = createHash("sha256").update(SECRET_VALUE, "utf8").digest("hex");
const SECRET_PREFIX_8 = SECRET_SHA256.slice(0, 8);
const SECRET_PREFIX_9 = SECRET_SHA256.slice(0, 9);

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join("/var/tmp", prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

interface FakeCliConfig {
  approvalUrl?: string;
  loginMode?: "ok" | "pending_then_ok" | "ok_with_decrypt" | "declined" | "expired" | "refused" | "bad_url" | "hang";
  whoamiOwnerDid?: string;
  whoamiAuthenticated?: boolean;
  exists?: boolean;
  storedValue?: string;
  putFails?: boolean;
}

interface RecordedCall {
  argv: string[];
  stdin: string;
  tcHome: string | undefined;
  hasPrivateKey: boolean;
  manifest?: Record<string, unknown>;
}

function createFakeTinycloud(dir: string, config: FakeCliConfig = {}): { binDir: string; logFile: string } {
  const binDir = join(dir, "bin");
  const stateDir = join(dir, "fake-state");
  const logFile = join(dir, "calls.jsonl");
  const configFile = join(dir, "config.json");
  const fakeScript = join(binDir, "tinycloud");
  mkdirSync(binDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    configFile,
    JSON.stringify({
      approvalUrl: config.approvalUrl ?? APPROVAL_URL,
      loginMode: config.loginMode ?? "ok",
      whoamiOwnerDid: config.whoamiOwnerDid ?? OWNER_DID_LOWER,
      whoamiAuthenticated: config.whoamiAuthenticated ?? true,
      exists: config.exists ?? false,
      storedValue: config.storedValue ?? SECRET_VALUE,
      putFails: config.putFails ?? false,
      stateDir,
    }),
  );

  writeFileSync(
    fakeScript,
    `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

const cfg = JSON.parse(fs.readFileSync(${JSON.stringify(configFile)}, "utf8"));
const logFile = ${JSON.stringify(logFile)};
const argv = process.argv.slice(2);
const stdin = fs.readFileSync(0, "utf8");

let manifest;
const mIdx = argv.indexOf("--manifest");
if (mIdx >= 0 && argv[mIdx + 1] && fs.existsSync(argv[mIdx + 1])) {
  manifest = JSON.parse(fs.readFileSync(argv[mIdx + 1], "utf8"));
}

fs.appendFileSync(
  logFile,
  JSON.stringify({
    argv,
    stdin,
    tcHome: process.env.TC_HOME,
    hasPrivateKey: Object.prototype.hasOwnProperty.call(process.env, "TC_PRIVATE_KEY"),
    manifest,
  }) + "\\n",
);

// Strip global flags to find the command sequence.
const cmd = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--profile" || a === "-p" || a === "--host" || a === "-H") {
    i++;
    continue;
  }
  if (a.startsWith("--")) continue;
  cmd.push(a);
}

if (cmd[0] === "init") {
  process.stdout.write(JSON.stringify({ profile: "connector-master-backup", authenticated: false }) + "\\n");
  process.exit(0);
}

if (cmd[0] === "auth" && cmd[1] === "login") {
  const counterFile = path.join(cfg.stateDir, "login-attempts");
  const attempt = fs.existsSync(counterFile) ? Number(fs.readFileSync(counterFile, "utf8")) + 1 : 1;
  fs.writeFileSync(counterFile, String(attempt));

  if (cfg.loginMode === "bad_url") {
    process.stderr.write("Approve this request in OpenKey (open the complete link):\\nhttps://evil.example/a/123#tok\\n");
    setTimeout(() => process.exit(0), 2000);
    return;
  }

  process.stderr.write(\`Approve this request in OpenKey (open the complete link):\\n\${cfg.approvalUrl}\\nThe link is valid until 2099-01-01T00:00:00.000Z.\\n\`);

  if (cfg.loginMode === "hang") {
    setTimeout(() => process.exit(0), 30000);
    return;
  }

  if (cfg.loginMode === "pending_then_ok" && attempt === 1) {
    process.stdout.write(JSON.stringify({ pending: { step: 1, of: 1, approvalUrl: cfg.approvalUrl, expiresAt: "2099-01-01T00:00:00.000Z" } }) + "\\n");
    process.exit(8);
  }
  if (cfg.loginMode === "expired") {
    process.stderr.write(JSON.stringify({ error: { code: "APPROVAL_REQUEST_EXPIRED", message: "expired" } }) + "\\n");
    process.exit(3);
  }
  if (cfg.loginMode === "refused") {
    process.stderr.write(JSON.stringify({ error: { code: "OPENKEY_OWNER_MISMATCH", message: "refused" } }) + "\\n");
    process.exit(5);
  }
  if (cfg.loginMode === "declined") {
    process.stdout.write(JSON.stringify({
      authenticated: true,
      ownerDid: cfg.whoamiOwnerDid,
      permissions: [],
      declined: [{ service: "tinycloud.kv", path: "vault/secrets/CONNECTOR_CREDENTIAL_MASTER", actions: ["tinycloud.kv/put"] }],
    }) + "\\n");
    process.exit(0);
  }

  const permissions = [
    { service: "tinycloud.kv", space: "secrets", path: "vault/secrets/CONNECTOR_CREDENTIAL_MASTER", actions: ["tinycloud.kv/get", "tinycloud.kv/put"] },
    { service: "tinycloud.capabilities", space: "secrets", path: "", actions: ["tinycloud.capabilities/read"] },
  ];
  if (cfg.loginMode === "ok_with_decrypt") {
    permissions.push({
      service: "tinycloud.encryption",
      space: "encryption",
      path: \`urn:tinycloud:encryption:\${cfg.whoamiOwnerDid}:default\`,
      actions: ["tinycloud.encryption/decrypt"],
    });
  }
  process.stdout.write(JSON.stringify({
    authenticated: true,
    ownerDid: cfg.whoamiOwnerDid,
    permissions,
    declined: [],
    expiresAt: "2099-01-01T01:00:00.000Z",
  }) + "\\n");
  process.exit(0);
}

if (cmd[0] === "auth" && cmd[1] === "whoami") {
  process.stdout.write(JSON.stringify({
    profile: "connector-master-backup",
    ownerDid: cfg.whoamiOwnerDid,
    authenticated: cfg.whoamiAuthenticated,
  }) + "\\n");
  process.exit(0);
}

if (cmd[0] === "auth" && cmd[1] === "logout") {
  process.stdout.write(JSON.stringify({ profile: "connector-master-backup", authenticated: false }) + "\\n");
  process.exit(0);
}

if (cmd[0] === "secrets" && cmd[1] === "wait") {
  if (cfg.exists) {
    process.stdout.write(JSON.stringify({ status: "ready", names: ["CONNECTOR_CREDENTIAL_MASTER"] }) + "\\n");
    process.exit(0);
  }
  process.stdout.write(JSON.stringify({
    status: "pending",
    present: [],
    pending: ["CONNECTOR_CREDENTIAL_MASTER"],
  }) + "\\n");
  process.exit(8);
}

if (cmd[0] === "secrets" && cmd[1] === "put") {
  if (cfg.putFails) {
    process.stderr.write(JSON.stringify({ error: { code: "STORAGE_ERROR", message: "boom" } }) + "\\n");
    process.exit(1);
  }
  fs.writeFileSync(path.join(cfg.stateDir, "stored-secret"), stdin, "utf8");
  process.stdout.write(JSON.stringify({ name: "CONNECTOR_CREDENTIAL_MASTER", written: true }) + "\\n");
  process.exit(0);
}

if (cmd[0] === "secrets" && cmd[1] === "get") {
  const storedPath = path.join(cfg.stateDir, "stored-secret");
  const val = fs.existsSync(storedPath) ? fs.readFileSync(storedPath, "utf8") : cfg.storedValue;
  process.stdout.write(val);
  process.exit(0);
}

process.stderr.write(JSON.stringify({ error: { code: "UNKNOWN_CMD", message: cmd.join(" ") } }) + "\\n");
process.exit(2);
`,
    "utf8",
  );
  chmodSync(fakeScript, 0o755);
  return { binDir, logFile };
}

function readCalls(logFile: string): RecordedCall[] {
  try {
    return readFileSync(logFile, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as RecordedCall);
  } catch {
    return [];
  }
}

async function runScript(
  envOverrides: Record<string, string | undefined>,
  fakeConfig?: FakeCliConfig,
): Promise<{
  stdout: string;
  stderr: string;
  code: number;
  calls: RecordedCall[];
  tmpRoot: string;
}> {
  const sandbox = makeTempDir("tc3895-test-");
  const tmpRoot = join(sandbox, "tmp");
  mkdirSync(tmpRoot, { recursive: true });
  const { binDir, logFile } = createFakeTinycloud(sandbox, fakeConfig);

  const env: Record<string, string> = {
    PATH: `${binDir}:${process.env.PATH ?? ""}`,
    TMPDIR: tmpRoot,
    GITHUB_REF: "refs/heads/main",
    OWNER_DID,
    CONNECTOR_CREDENTIAL_MASTER: SECRET_VALUE,
    TC_BACKUP_APPROVAL_TIMEOUT_SECONDS: "10",
    TC_BACKUP_POLL_SLEEP_SECONDS: "0.05",
  };
  for (const [k, v] of Object.entries(envOverrides)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }

  const proc = Bun.spawn(["bash", SCRIPT], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { stdout, stderr, code, calls: readCalls(logFile), tmpRoot };
}

describe("backup-connector-master.sh", () => {
  test("writes the secret via stdin only, uses the exact narrow manifest, logs fixed lines + 8-hex prefix, logs out and removes temp dir", async () => {
    const result = await runScript({ TC_PRIVATE_KEY: "0xdeadbeef" });

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(
      `status=approval_required\n${APPROVAL_URL}\nsecret=CONNECTOR_CREDENTIAL_MASTER sha256_prefix=${SECRET_PREFIX_8} match=unverified\n`,
    );

    // Value and 9+ hex prefix must never appear in stdout or stderr.
    const combined = result.stdout + result.stderr;
    expect(combined).not.toContain(SECRET_VALUE);
    expect(combined).not.toContain(SECRET_PREFIX_9);
    expect(combined).not.toContain(SECRET_SHA256);

    // Temp dir created by the script must be removed by the trap.
    expect(readdirSync(result.tmpRoot)).toEqual([]);

    // Never forwards TC_PRIVATE_KEY to any CLI call.
    expect(result.calls.length).toBeGreaterThanOrEqual(6);
    for (const call of result.calls) {
      expect(call.hasPrivateKey).toBe(false);
      expect(call.argv.join(" ")).not.toContain(SECRET_VALUE);
      expect(call.tcHome).toMatch(/tc-backup-cmk\.[^/]+\/tc-home$/);
    }

    // Check auth login flags and exact manifest (no decrypt, no list, single secret name).
    const loginCall = result.calls.find((c) => c.argv.includes("login"));
    expect(loginCall).toBeDefined();
    expect(loginCall!.argv).toContain("--no-popup");
    expect(loginCall!.argv).toContain("--expiry");
    expect(loginCall!.argv[loginCall!.argv.indexOf("--expiry") + 1]).toBe("1h");
    expect(loginCall!.argv).toContain("--owner");
    expect(loginCall!.argv[loginCall!.argv.indexOf("--owner") + 1]).toBe(OWNER_DID);
    expect(loginCall!.argv).not.toContain("--paste");
    expect(loginCall!.manifest).toEqual({
      manifest_version: 1,
      app_id: "xyz.tinycloud.tinychat-connector-master-backup",
      name: "One-off backup of CONNECTOR_CREDENTIAL_MASTER",
      space: "secrets",
      permissions: [
        {
          service: "tinycloud.kv",
          path: "vault/secrets/CONNECTOR_CREDENTIAL_MASTER",
          actions: ["get", "put"],
          skipPrefix: true,
        },
        {
          service: "tinycloud.capabilities",
          path: "",
          actions: ["read"],
          skipPrefix: true,
        },
      ],
    });

    // Check secrets put receives exact bytes on stdin only and never in argv.
    const putCall = result.calls.find((c) => c.argv.includes("put"));
    expect(putCall).toBeDefined();
    expect(putCall!.argv).toContain("--stdin");
    expect(putCall!.argv).toContain("CONNECTOR_CREDENTIAL_MASTER");
    expect(putCall!.stdin).toBe(SECRET_VALUE);

    // Must finish with auth logout.
    const lastCall = result.calls[result.calls.length - 1]!;
    expect(lastCall.argv).toContain("auth");
    expect(lastCall.argv).toContain("logout");
  });

  test("masks the secret first via ::add-mask:: when GITHUB_ACTIONS=true", async () => {
    const result = await runScript({ GITHUB_ACTIONS: "true" });
    expect(result.code).toBe(0);
    const lines = result.stdout.split("\n");
    expect(lines[0]).toBe(`::add-mask::${SECRET_VALUE}`);
    expect(lines[1]).toBe("status=approval_required");
    expect(lines[2]).toBe(APPROVAL_URL);
    expect(lines[3]).toBe(`secret=CONNECTOR_CREDENTIAL_MASTER sha256_prefix=${SECRET_PREFIX_8} match=unverified`);
    expect(readdirSync(result.tmpRoot)).toEqual([]);
  });

  test("resumes when auth login exits 8 while pending without duplicating the approval link", async () => {
    const result = await runScript({}, { loginMode: "pending_then_ok" });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(
      `status=approval_required\n${APPROVAL_URL}\nsecret=CONNECTOR_CREDENTIAL_MASTER sha256_prefix=${SECRET_PREFIX_8} match=unverified\n`,
    );
    const loginCalls = result.calls.filter((c) => c.argv.includes("login"));
    expect(loginCalls.length).toBe(2);
    expect(readdirSync(result.tmpRoot)).toEqual([]);
  });

  test("verifies read-back via secrets get --raw when decrypt permission is granted", async () => {
    const ok = await runScript({}, { loginMode: "ok_with_decrypt" });
    expect(ok.code).toBe(0);
    expect(ok.stdout).toContain(`secret=CONNECTOR_CREDENTIAL_MASTER sha256_prefix=${SECRET_PREFIX_8} match=yes\n`);
    expect(ok.stdout + ok.stderr).not.toContain(SECRET_VALUE);
    expect(ok.stdout + ok.stderr).not.toContain(SECRET_PREFIX_9);

    const mismatch = await runScript({}, { loginMode: "ok_with_decrypt", exists: true, storedValue: "different-secret" });
    expect(mismatch.code).toBe(1);
    expect(mismatch.stdout).toContain(`secret=CONNECTOR_CREDENTIAL_MASTER sha256_prefix=${SECRET_PREFIX_8} match=no\n`);
    expect(mismatch.calls.some((c) => c.argv.includes("put"))).toBe(false);
  });

  test("refuses a non-main ref before invoking tinycloud", async () => {
    for (const ref of ["refs/heads/feat/other", "refs/pull/123/merge", ""]) {
      const result = await runScript({ GITHUB_REF: ref });
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("ref=refused\n");
      expect(result.stderr).toBe("");
      expect(result.calls).toEqual([]);
      expect(readdirSync(result.tmpRoot)).toEqual([]);
    }
  });

  test("refuses empty or malformed OWNER_DID and missing secret before invoking tinycloud", async () => {
    for (const badOwner of ["", "did:key:z123", "0xabcdef0123456789abcdef0123456789abcdef01", "did:pkh:eip155:1:0x1234"]) {
      const result = await runScript({ OWNER_DID: badOwner });
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("owner_did=invalid\n");
      expect(result.calls).toEqual([]);
    }

    const missingSecret = await runScript({ CONNECTOR_CREDENTIAL_MASTER: "" });
    expect(missingSecret.code).toBe(1);
    expect(missingSecret.stdout).toBe("secret=CONNECTOR_CREDENTIAL_MASTER value=missing\n");
    expect(missingSecret.calls).toEqual([]);
  });

  test("refuses when whoami ownerDid differs from OWNER_DID, never calls secrets put, logs out and cleans up", async () => {
    const result = await runScript({}, { whoamiOwnerDid: WRONG_OWNER_DID });
    expect(result.code).toBe(1);
    expect(result.stdout).toBe(`status=approval_required\n${APPROVAL_URL}\nstatus=owner_mismatch\n`);
    expect(result.stderr).toBe("");
    expect(result.stdout + result.stderr).not.toContain(SECRET_VALUE);
    expect(result.stdout + result.stderr).not.toContain(WRONG_OWNER_DID);
    expect(result.calls.some((c) => c.argv.includes("put"))).toBe(false);
    expect(result.calls.some((c) => c.argv.includes("logout"))).toBe(true);
    expect(readdirSync(result.tmpRoot)).toEqual([]);
  });

  test("refuses to overwrite an existing secret (add-only) and never calls secrets put", async () => {
    const result = await runScript({}, { exists: true });
    expect(result.code).toBe(1);
    expect(result.stdout).toBe(
      `status=approval_required\n${APPROVAL_URL}\nstatus=already_present\nsecret=CONNECTOR_CREDENTIAL_MASTER sha256_prefix=${SECRET_PREFIX_8} match=unverified\n`,
    );
    expect(result.stderr).toBe("");
    expect(result.stdout + result.stderr).not.toContain(SECRET_VALUE);
    expect(result.stdout + result.stderr).not.toContain(SECRET_PREFIX_9);
    expect(result.calls.some((c) => c.argv.includes("put"))).toBe(false);
    expect(result.calls.some((c) => c.argv.includes("logout"))).toBe(true);
    expect(readdirSync(result.tmpRoot)).toEqual([]);
  });

  test("exits 0 when existing secret is already present and matches under decrypt-enabled read-back", async () => {
    const result = await runScript({}, { loginMode: "ok_with_decrypt", exists: true, storedValue: SECRET_VALUE });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(
      `status=approval_required\n${APPROVAL_URL}\nstatus=already_present\nsecret=CONNECTOR_CREDENTIAL_MASTER sha256_prefix=${SECRET_PREFIX_8} match=yes\n`,
    );
    expect(result.calls.some((c) => c.argv.includes("put"))).toBe(false);
    expect(readdirSync(result.tmpRoot)).toEqual([]);
  });

  test("refuses non-OpenKey approval links and removes temp dir on failure", async () => {
    const result = await runScript({}, { loginMode: "bad_url" });
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("status=approval_link_refused\n");
    expect(result.stdout).not.toContain("evil.example");
    expect(result.calls.some((c) => c.argv.includes("put"))).toBe(false);
    expect(readdirSync(result.tmpRoot)).toEqual([]);
  });

  test("refuses when any requested permission is declined and never calls secrets put", async () => {
    const result = await runScript({}, { loginMode: "declined" });
    expect(result.code).toBe(1);
    expect(result.stdout).toBe(`status=approval_required\n${APPROVAL_URL}\nstatus=permission_declined\n`);
    expect(result.calls.some((c) => c.argv.includes("put"))).toBe(false);
    expect(result.calls.some((c) => c.argv.includes("logout"))).toBe(true);
    expect(readdirSync(result.tmpRoot)).toEqual([]);
  });

  test("times out cleanly when approval never arrives, stops login and removes temp dir", async () => {
    const result = await runScript(
      { TC_BACKUP_APPROVAL_TIMEOUT_SECONDS: "1", TC_BACKUP_POLL_SLEEP_SECONDS: "0.05" },
      { loginMode: "hang" },
    );
    expect(result.code).toBe(1);
    expect(result.stdout).toBe(`status=approval_required\n${APPROVAL_URL}\nstatus=approval_timeout\n`);
    expect(result.stderr).toBe("");
    expect(result.calls.some((c) => c.argv.includes("put"))).toBe(false);
    expect(readdirSync(result.tmpRoot)).toEqual([]);
  });

  test("logs fixed error, logs out and removes temp dir when secrets put fails", async () => {
    const result = await runScript({}, { putFails: true });
    expect(result.code).toBe(1);
    expect(result.stdout).toBe(`status=approval_required\n${APPROVAL_URL}\nstatus=write_failed\n`);
    expect(result.stderr).toBe("");
    expect(result.stdout + result.stderr).not.toContain(SECRET_VALUE);
    expect(result.calls.some((c) => c.argv.includes("logout"))).toBe(true);
    expect(readdirSync(result.tmpRoot)).toEqual([]);
  });
});

describe("backup-connector-master.yml workflow structure", () => {
  test("enforces dispatch-only, main-only, production-api, read permissions, pinned SHAs, sparse-checkout and no artifacts or set -x", () => {
    const raw = readFileSync(WORKFLOW, "utf8");
    const doc = yaml.load(raw) as Record<string, any>;

    // workflow_dispatch only.
    expect(Object.keys(doc.on)).toEqual(["workflow_dispatch"]);

    // Minimal permissions and concurrency group.
    expect(doc.permissions).toEqual({ contents: "read" });
    expect(typeof doc.concurrency?.group).toBe("string");
    expect(doc.concurrency.group.length).toBeGreaterThan(0);

    // Single job guarded by main ref, production-api environment, bounded timeout.
    const jobNames = Object.keys(doc.jobs);
    expect(jobNames).toEqual(["backup"]);
    const job = doc.jobs.backup;
    expect(job.if).toBe("github.ref == 'refs/heads/main'");
    expect(job.environment).toEqual({ name: "production-api" });
    expect(job["timeout-minutes"]).toBeGreaterThanOrEqual(15);
    expect(job["timeout-minutes"]).toBeLessThanOrEqual(30);

    // First step explicitly refuses any ref other than refs/heads/main.
    const steps = job.steps as Array<Record<string, any>>;
    expect(steps.length).toBeGreaterThanOrEqual(3);
    expect(steps[0]!.run).toContain("refs/heads/main");
    expect(steps[0]!.run).toContain("exit 1");

    // Checkout uses sparse-checkout for scripts/ops only and disables credential persistence.
    const checkoutStep = steps.find((s) => typeof s.uses === "string" && s.uses.startsWith("actions/checkout@"));
    expect(checkoutStep).toBeDefined();
    expect(checkoutStep!.with).toEqual({
      "persist-credentials": false,
      "sparse-checkout": "scripts/ops",
    });

    // Every action is pinned to a full 40-hex commit SHA.
    const actionSteps = steps.filter((s) => typeof s.uses === "string");
    expect(actionSteps.length).toBeGreaterThanOrEqual(2);
    for (const step of actionSteps) {
      expect(step.uses).toMatch(/^[^@]+@[0-9a-f]{40}$/);
    }

    // Secret appears only in the env of the one backup step.
    const stepsReferencingSecret = steps.filter((s) =>
      JSON.stringify(s).includes("CONNECTOR_CREDENTIAL_MASTER"),
    );
    expect(stepsReferencingSecret.length).toBe(1);
    expect(stepsReferencingSecret[0]!.env?.CONNECTOR_CREDENTIAL_MASTER).toBe(
      "${{ secrets.CONNECTOR_CREDENTIAL_MASTER }}",
    );
    expect(stepsReferencingSecret[0]!.env?.OWNER_DID).toBe("${{ vars.TC_BACKUP_OWNER_DID }}");

    // No artifact uploads and no shell tracing.
    expect(raw).not.toMatch(/upload-artifact/i);
    expect(raw).not.toMatch(/set\s+-[a-zA-Z]*x/);
    expect(readFileSync(SCRIPT, "utf8")).not.toMatch(/set\s+-[a-zA-Z]*x/);
  });
});
