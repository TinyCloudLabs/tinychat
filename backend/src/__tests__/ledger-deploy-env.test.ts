import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { load as loadYaml } from "js-yaml";

const defaultWorkflowPath = resolve(import.meta.dir, "../../../.github/workflows/deploy-backend-phala.yml");

type DeployStep = { name?: string; env?: Record<string, unknown>; run?: string };
type DeployWorkflow = {
  jobs?: {
    deploy?: {
      steps?: DeployStep[];
    };
  };
};

const LEDGER_KEYS = [
  "LEDGER_SERVICE_URL",
  "LEDGER_SERVICE_SECRET",
  "LEDGER_AUTHORITATIVE",
  "LEDGER_OUTAGE_POLICY",
] as const;

function readWorkflow(workflowPath = process.env.UL_DEPLOY_WORKFLOW_PATH ?? defaultWorkflowPath): DeployWorkflow {
  return loadYaml(readFileSync(workflowPath, "utf8")) as DeployWorkflow;
}

function deployEnvWriter(workflow: DeployWorkflow): DeployStep | undefined {
  return workflow.jobs?.deploy?.steps?.find(
    (step) => typeof step.run === "string" && step.run.includes('ENV_FILE="$RUNNER_TEMP/phala-prod.env"'),
  );
}

describe("Phala backend deploy ledger environment", () => {
  test("declares and writes every LEDGER_* setting into the deployed ENV_FILE", () => {
    const writer = deployEnvWriter(readWorkflow());

    expect(writer?.run).toBeTruthy();
    for (const key of LEDGER_KEYS) {
      expect(Object.hasOwn(writer?.env ?? {}, key)).toBe(true);
      expect(writer?.run).toContain(`"${key}=`);
    }
  });
});
