import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { load as loadYaml } from "js-yaml";
import { meetingRolloutFromEnv } from "../transcripts/meeting-rollout.js";

test("rollout defaults off and requires explicit test accounts and evaluated models", () => {
  const off = meetingRolloutFromEnv({});
  expect(off.enabled).toBe(false); expect(off.accountAllowed("0xabc")).toBe(false); expect(off.modelAllowed("phala/test")).toBe(false);
  const gated = meetingRolloutFromEnv({ MEETING_CONTENT_RETRIEVAL_ENABLED: "true", MEETING_CONTENT_TEST_ACCOUNTS: "0xAbC, 0xdef", MEETING_CONTENT_MODELS: "phala/test" });
  expect(gated.enabled).toBe(true); expect(gated.accountAllowed("0xabc")).toBe(true); expect(gated.accountAllowed("0xother")).toBe(false);
  expect(gated.modelAllowed("phala/test")).toBe(true); expect(gated.modelAllowed("phala/other")).toBe(false);
  expect(meetingRolloutFromEnv({ MEETING_CONTENT_RETRIEVAL_ENABLED: "true" }).accountAllowed("0xabc")).toBe(false);
});

type DeployStep = { env?: Record<string, unknown>; run?: string };
type DeployWorkflow = { jobs?: { deploy?: { steps?: DeployStep[] } } };
type PhalaCompose = { services?: Record<string, { environment?: Record<string, string> }> };
const repoRoot = resolve(import.meta.dir, "../../..");

describe("Phala backend deploy meeting rollout environment", () => {
  test.each([
    ["MEETING_CONTENT_RETRIEVAL_ENABLED", "${{ vars.MEETING_CONTENT_RETRIEVAL_ENABLED || 'false' }}", "false"],
    ["MEETING_CONTENT_TEST_ACCOUNTS", "${{ vars.MEETING_CONTENT_TEST_ACCOUNTS }}", ""],
    ["MEETING_CONTENT_MODELS", "${{ vars.MEETING_CONTENT_MODELS }}", ""],
  ])("forwards optional %s through deployment with its inactive default", (key, expression, fallback) => {
    const workflow = loadYaml(readFileSync(resolve(repoRoot, ".github/workflows/deploy-backend-phala.yml"), "utf8")) as DeployWorkflow;
    const writer = workflow.jobs?.deploy?.steps?.find(step => step.run?.includes('ENV_FILE="$RUNNER_TEMP/phala-prod.env"'));
    const compose = loadYaml(readFileSync(resolve(repoRoot, "docker-compose.phala.yml"), "utf8")) as PhalaCompose;
    const example = readFileSync(resolve(repoRoot, "backend/.env.example"), "utf8");
    const interpolation = `\${${key}:-${fallback}}`;

    expect(writer?.env?.[key]).toBe(expression);
    // The unconditional printf keeps the key in the env file even for an empty list.
    expect(writer?.run).toContain(`printf '%s\\n' "${key}=${interpolation}"`);
    expect(compose.services?.["tinychat-backend"]?.environment?.[key]).toBe(interpolation);
    expect([...example.matchAll(new RegExp(`^${key}=(.*)$`, "gm"))].map(match => match[1])).toEqual([fallback]);
  });
});
