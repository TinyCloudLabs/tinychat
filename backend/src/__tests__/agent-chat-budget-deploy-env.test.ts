import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { load as loadYaml } from "js-yaml";

const root = resolve(import.meta.dir, "../../..");
const workflowPath = resolve(root, ".github/workflows/deploy-backend-phala.yml");

type DeployStep = { name?: string; env?: Record<string, unknown>; run?: string };
type DeployWorkflow = {
  jobs?: {
    deploy?: {
      steps?: DeployStep[];
    };
  };
};
type Compose = { services?: Record<string, { environment?: Record<string, unknown> }> };

const BUDGET_KEYS = ["AGENT_CHAT_BUDGET_STOP_MODE", "AGENT_CHAT_BUDGET_PREFLIGHT"] as const;

function readWorkflow(): DeployWorkflow {
  return loadYaml(readFileSync(workflowPath, "utf8")) as DeployWorkflow;
}

function deployEnvWriter(workflow: DeployWorkflow): DeployStep | undefined {
  return workflow.jobs?.deploy?.steps?.find(
    (step) => typeof step.run === "string" && step.run.includes('ENV_FILE="$RUNNER_TEMP/phala-prod.env"'),
  );
}

describe("Phala backend deploy agent chat budget environment", () => {
  test("forwards every budget setting from secrets or vars in the deploy env block", () => {
    const writer = deployEnvWriter(readWorkflow());

    for (const key of BUDGET_KEYS) {
      expect(writer?.env?.[key]).toBe(`\${{ secrets.${key} || vars.${key} }}`);
    }
  });

  test("writes every budget setting into the deployed ENV_FILE", () => {
    const writer = deployEnvWriter(readWorkflow());

    expect(writer?.run).toBeTruthy();
    for (const key of BUDGET_KEYS) {
      expect(writer?.run).toContain(`"${key}=$${key}"`);
    }
  });

  test("maps every budget setting in the compose backend with an empty default", () => {
    const compose = loadYaml(readFileSync(resolve(root, "docker-compose.phala.yml"), "utf8")) as Compose;
    const environment = compose.services?.["tinychat-backend"]?.environment ?? {};

    for (const key of BUDGET_KEYS) {
      expect(environment[key]).toBe(`\${${key}:-}`);
    }
  });

  test("documents every budget setting as a commented entry in backend/.env.example", () => {
    const example = readFileSync(resolve(root, "backend/.env.example"), "utf8");

    for (const key of BUDGET_KEYS) {
      expect(example).toContain(`# ${key}=`);
    }
  });
});
