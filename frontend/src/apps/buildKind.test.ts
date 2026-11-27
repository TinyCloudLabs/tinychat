// A bundler that doesn't define __ONE_APPS_BUILD_KIND__ (a test's Bun.build) gets production: no dev or preview origin.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";

test("an undefined build kind is production, with production origins only", () => {
  // Run outside frontend/, so bunfig.toml's define does not apply.
  const cwd = mkdtempSync(path.join("/var/tmp", "one-apps-build-kind."));
  try {
    const registry = path.join(import.meta.dir, "registry.ts");
    const script = `const r = await import(${JSON.stringify(registry)});
console.log(JSON.stringify({ kind: r.ONE_APPS_BUILD_KIND, hosts: r.ONE_HOST_ORIGINS,
  origins: r.ONE_APPS.filter((app) => app.kind === "framed").map((app) => app.origin) }));`;
    const run = Bun.spawnSync([process.execPath, "-e", script], { cwd, stdout: "pipe", stderr: "pipe" });
    expect(run.exitCode, run.stderr.toString()).toBe(0);
    expect(JSON.parse(run.stdout.toString())).toEqual({
      kind: "production",
      hosts: ["https://tinycloud.one"],
      origins: [
        "https://secrets.tinycloud.xyz",
        "https://credentials.org",
        "https://guqda7cucxregwu3pgrwcq6syc.apps.tinycloud.one",
        "https://explorer.tinycloud.xyz",
        "https://account.tinycloud.xyz",
        "https://share.tinycloud.xyz",
        "https://rocinante-ledger.pages.dev",
      ],
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
