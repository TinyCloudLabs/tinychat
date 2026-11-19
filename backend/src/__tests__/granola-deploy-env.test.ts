import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { load } from "js-yaml";

const root = resolve(import.meta.dir, "../../..");
const workflow = load(readFileSync(resolve(root, ".github/workflows/deploy-backend-phala.yml"), "utf8"));
const writer = workflow.jobs.deploy.steps.find((step: { run?: string }) => step.run?.includes('ENV_FILE="$RUNNER_TEMP/phala-prod.env"'));
const script = writer.run.split('echo "::group::Deploy environment keys"')[0];

for (const configured of [undefined, "true"]) {
  test(`Granola proxy deployment preserves ${configured ?? "disabled default"}`, () => {
    const temp = mkdtempSync(resolve(tmpdir(), "granola-deploy-"));
    try {
      const env: Record<string, string> = { RUNNER_TEMP: temp };
      if (configured !== undefined) env.GRANOLA_PROXY_ENABLED = configured;
      const result = Bun.spawnSync(["/bin/bash", "-c", script], { cwd: temp, env });
      expect(result.exitCode).toBe(0);
      const deployed = readFileSync(resolve(temp, "phala-prod.env"), "utf8");
      expect(deployed.split("\n")).toContain(`GRANOLA_PROXY_ENABLED=${configured ?? "false"}`);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });
}

test("Granola deployment rejects an injected environment setting", () => {
  const temp = mkdtempSync(resolve(tmpdir(), "granola-deploy-"));
  try {
    const result = Bun.spawnSync(["/bin/bash", "-c", script], {
      cwd: temp,
      env: { RUNNER_TEMP: temp, GRANOLA_PROXY_ENABLED: "true\nINJECTED=1" },
    });
    expect(result.exitCode).not.toBe(0);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
