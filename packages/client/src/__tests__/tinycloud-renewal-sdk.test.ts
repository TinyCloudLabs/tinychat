import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("published SDK verifies signed renewal proofs, account binding and restore fences", () => {
  const privateRoot = mkdtempSync(join(tmpdir(), "tc2872-sdk-regressions-"));
  const home = join(privateRoot, "home");
  const tcHome = join(privateRoot, "tc");
  mkdirSync(home);
  mkdirSync(tcHome);
  try {
    const root = fileURLToPath(new URL("../../../../", import.meta.url));
    const probe = Bun.spawnSync(
      [
        process.execPath,
        "--no-env-file",
        join(root, "scripts/renewal/transcript-renewal-regressions.mjs"),
      ],
      {
        cwd: root,
        env: { ...process.env, HOME: home, TC_HOME: tcHome },
        timeout: 20_000,
      },
    );
    expect(probe.stderr.toString()).toBe("");
    expect(probe.exitCode).toBe(0);
    const result = JSON.parse(probe.stdout.toString());
    expect(result.result).toBe("PASS");
    expect(result.realSignedProofs).toBe(true);
    expect(result.outcomes).toHaveLength(12);
  } finally {
    rmSync(privateRoot, { recursive: true, force: true });
  }
}, 30_000);
