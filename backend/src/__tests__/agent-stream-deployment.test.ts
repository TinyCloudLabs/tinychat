import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { load } from "js-yaml";
import { agentStreamPolicyFromEnv } from "../agent-stream-policy.js";

const root = resolve(import.meta.dir, "../../..");
const workflow = load(readFileSync(resolve(root, ".github/workflows/deploy-backend-phala.yml"), "utf8")) as any;
const compose = load(readFileSync(resolve(root, "docker-compose.phala.yml"), "utf8")) as any;
const steps = workflow.jobs.deploy.steps as Array<{ name?: string; env?: Record<string, string>; run?: string }>;
const check = steps.find((step) => step.name === "Check deployment configuration")!;
const deploy = steps.find((step) => step.name === "Deploy to Phala Cloud")!;
const streamEnv = {
  AGENT_STREAM_HEARTBEAT_MS: "17",
  AGENT_STREAM_TURN_TIMEOUT_MS: "251",
  AGENT_STREAM_DRAIN_GRACE_MS: "31",
};

function checkDeployment(settings: Record<string, string | undefined>) {
  const temp = mkdtempSync(resolve(tmpdir(), "tinychat-stream-config-"));
  try {
    const env = Object.fromEntries(Object.keys(check.env ?? {}).map((key) => [key, "synthetic-config"]));
    const result = Bun.spawnSync(["/bin/bash", "-c", check.run!], {
      env: {
        PATH: "/usr/bin:/bin:/usr/local/bin",
        ...env,
        ...settings,
        GITHUB_STEP_SUMMARY: resolve(temp, "summary"),
      },
    });
    return { exitCode: result.exitCode, output: result.stdout.toString() + result.stderr.toString() };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

describe("agent stream deployment policy", () => {
  test("rejects absent stream settings before building or deploying", () => {
    const result = checkDeployment({});
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain("AGENT_STREAM_HEARTBEAT_MS");
  });

  test("validates all three settings with the same numeric contract and safe errors", () => {
    for (const setting of Object.keys(streamEnv)) {
      for (const value of ["", "  ", " 17", "17 ", "17\n", "\n17", "0", "-1", "1.5", "1e3", "0x10", "NaN", "Infinity", "2147483648", "synthetic-private-sentinel\n31"]) {
        const result = checkDeployment({ ...streamEnv, [setting]: value });
        expect(result.exitCode).not.toBe(0);
        expect(result.output).toContain(`Invalid agent stream configuration: ${setting}`);
        expect(result.output).not.toContain("synthetic-private-sentinel");
      }
    }
  });

  test("accepts explicit values including the scheduler boundaries", () => {
    expect(checkDeployment(streamEnv).exitCode).toBe(0);
    expect(checkDeployment({ ...streamEnv, AGENT_STREAM_HEARTBEAT_MS: "1", AGENT_STREAM_TURN_TIMEOUT_MS: "2147483647" }).exitCode).toBe(0);
  });

  test("forwards repository variables through the deploy env file and compose unchanged", () => {
    const forwarded: Record<string, string> = {};
    for (const [setting, value] of Object.entries(streamEnv)) {
      expect(deploy.env?.[setting] ?? workflow.env?.[setting]).toBe(`\${{ vars.${setting} }}`);
      const line = deploy.run!.split("\n").find((entry) => entry.includes(`"${setting}=$${setting}"`));
      expect(line).toBeDefined();
      const result = Bun.spawnSync(["/bin/bash", "-c", line!], { env: { [setting]: value } });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString()).toBe(`${setting}=${value}\n`);
      const expression = compose.services["tinychat-backend"].environment[setting];
      expect(expression).toBe(`\${${setting}:-}`);
      forwarded[setting] = result.stdout.toString().trim().split("=")[1]!;
    }
    expect(agentStreamPolicyFromEnv(forwarded, true)).toEqual({ heartbeatMs: 17, turnTimeoutMs: 251, drainGraceMs: 31 });
  });
});
