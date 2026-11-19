import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { load as loadYaml } from "js-yaml";

const root = resolve(import.meta.dir, "../../..");
const workflowPath = resolve(root, ".github/workflows/deploy-backend-phala.yml");
const KEY = "EXO_CAPABILITIES_ENABLED";

type DeployStep = { name?: string; env?: Record<string, unknown>; run?: string };
type DeployWorkflow = {
  jobs?: {
    deploy?: {
      steps?: DeployStep[];
    };
  };
};
type Compose = { services?: Record<string, { environment?: Record<string, unknown> }> };

function deployEnvWriter(): DeployStep | undefined {
  const workflow = loadYaml(readFileSync(workflowPath, "utf8")) as DeployWorkflow;
  return workflow.jobs?.deploy?.steps?.find(
    (step) => typeof step.run === "string" && step.run.includes('ENV_FILE="$RUNNER_TEMP/phala-prod.env"'),
  );
}

describe("Phala backend deploy exo capabilities environment", () => {
  test("forwards the flag from secrets or vars in the deploy env block", () => {
    expect(deployEnvWriter()?.env?.[KEY]).toBe(`\${{ secrets.${KEY} || vars.${KEY} }}`);
  });

  test("writes the flag into the deployed ENV_FILE", () => {
    const writer = deployEnvWriter();

    expect(writer?.run).toContain(`"${KEY}=$${KEY}"`);
  });

  test("maps the flag in the compose backend with an empty default", () => {
    const compose = loadYaml(readFileSync(resolve(root, "docker-compose.phala.yml"), "utf8")) as Compose;
    const environment = compose.services?.["tinychat-backend"]?.environment ?? {};

    expect(environment[KEY]).toBe(`\${${KEY}:-}`);
  });

  test("documents the flag as a commented entry in backend/.env.example", () => {
    const example = readFileSync(resolve(root, "backend/.env.example"), "utf8");

    expect(example).toContain(`# ${KEY}=`);
  });
});
