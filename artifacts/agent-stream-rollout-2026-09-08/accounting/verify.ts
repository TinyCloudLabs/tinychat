// Offline validation only. Execute the inspected workflow's configuration check,
// never its build, login, or deployment steps.
import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { agentStreamPolicyFromEnv } from "../../../backend/src/agent-stream-policy.ts";

assert.equal(Bun.version, "1.4.0", "Use the PR's pinned Bun runtime");
const root = resolve(import.meta.dir, "../../..");
const backendRequire = createRequire(
  new URL("../../../backend/package.json", import.meta.url),
);
const { load } = backendRequire("js-yaml");
const workflow = load(
  readFileSync(
    resolve(root, ".github/workflows/deploy-backend-phala.yml"),
    "utf8",
  ),
);
const compose = load(
  readFileSync(resolve(root, "docker-compose.phala.yml"), "utf8"),
);
const steps = workflow.jobs.deploy.steps as Array<{
  name?: string;
  env?: Record<string, string>;
  run?: string;
}>;
const check = steps.find(
  (step) => step.name === "Check deployment configuration",
)!;
const deploy = steps.find((step) => step.name === "Deploy to Phala Cloud")!;
const candidate = {
  AGENT_STREAM_HEARTBEAT_MS: "10000",
  AGENT_STREAM_TURN_TIMEOUT_MS: "300000",
  AGENT_STREAM_DRAIN_GRACE_MS: "5000",
};
const expected = {
  heartbeatMs: 10000,
  turnTimeoutMs: 300000,
  drainGraceMs: 5000,
};
assert.deepEqual(agentStreamPolicyFromEnv(candidate, true), expected);
const cleanEnv = {
  PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/local/bin`,
};
const temp = mkdtempSync(resolve(tmpdir(), "tinychat-pr67-policy-"));
let preflightOutput: string;
try {
  const syntheticConfig = Object.fromEntries(
    Object.keys(check.env ?? {}).map((key) => [key, "synthetic-config"]),
  );
  const result = Bun.spawnSync(["/bin/bash", "-c", check.run!], {
    env: {
      ...cleanEnv,
      ...syntheticConfig,
      ...candidate,
      GITHUB_STEP_SUMMARY: resolve(temp, "summary"),
    },
  });
  assert.equal(
    result.exitCode,
    0,
    result.stdout.toString() + result.stderr.toString(),
  );
  preflightOutput = result.stdout.toString().trim();
} finally {
  rmSync(temp, { recursive: true, force: true });
}

const forwarded: Record<string, string> = {};
for (const [setting, value] of Object.entries(candidate)) {
  assert.equal(
    deploy.env?.[setting] ?? workflow.env?.[setting],
    `\${{ vars.${setting} }}`,
  );
  const line = deploy
    .run!.split("\n")
    .find((entry) => entry.includes(`"${setting}=$${setting}"`));
  assert.ok(line, `Missing deploy env-file forwarding for ${setting}`);
  const result = Bun.spawnSync(["/bin/bash", "-c", line], {
    env: { ...cleanEnv, [setting]: value },
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.toString(), `${setting}=${value}\n`);
  assert.equal(
    compose.services["tinychat-backend"].environment[setting],
    `\${${setting}:-}`,
  );
  forwarded[setting] = result.stdout.toString().trim().split("=")[1]!;
}
assert.deepEqual(agentStreamPolicyFromEnv(forwarded, true), expected);

const suites = [
  {
    name: "maintained_policy_and_deployment",
    args: [
      "backend/src/__tests__/agent-stream-policy.test.ts",
      "backend/src/__tests__/agent-stream-deployment.test.ts",
    ],
    expectedPasses: 89,
  },
  {
    name: "maintained_accounting",
    args: [
      "backend/src/__tests__/agent-chat.test.ts",
      "backend/src/__tests__/agent-chat-lifecycle.test.ts",
      "-t",
      "accounting|completed usage|completed-result|recordUsage|prior-round",
    ],
    expectedPasses: 14,
  },
];
const tests = suites.map(({ name, args, expectedPasses }) => {
  const result = Bun.spawnSync(
    [process.execPath, "--no-env-file", "--no-install", "test", ...args],
    { cwd: root, env: cleanEnv },
  );
  const output = result.stdout.toString() + result.stderr.toString();
  assert.equal(result.exitCode, 0, output);
  const passed = Number(output.match(/\n\s*(\d+) pass\b/)?.[1]);
  const failed = Number(output.match(/\n\s*(\d+) fail\b/)?.[1]);
  assert.equal(passed, expectedPasses, name);
  assert.equal(failed, 0, name);
  return {
    name,
    command: ["bun", "--no-env-file", "--no-install", "test", ...args],
    passed,
    failed,
  };
});

console.log(
  JSON.stringify(
    {
      runtime: `Bun ${Bun.version}`,
      candidate,
      parsedPolicy: expected,
      preflightOutput,
      deployEnvFileAndComposeRoundTrip: "passed",
      tests,
      scope:
        "Offline validation with synthetic required config; no production values changed, no production timing measurement, and no policy approval inferred.",
    },
    null,
    2,
  ),
);
