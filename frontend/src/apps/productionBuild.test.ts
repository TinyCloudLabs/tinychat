// A real production build with One Apps on carries no preview or dev origin.
// "localhost" alone is not checked: shipped SDK and loopback-guard code names it; the One Apps dev origins are ports.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";

const frontend = path.join(import.meta.dir, "../..");
// The Ship ledger's production origin is the one pages.dev host allowed; its previews and branch aliases are not.
const FORBIDDEN = [/(?<!\/\/rocinante-ledger\.)pages\.dev/, /localhost:5\d{3}/, /feat-one-apps/, /one-apps-dev/];

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(path.join(dir, entry.name)) : [path.join(dir, entry.name)]);
}

describe("One Apps production build", () => {
  test("bundle and _headers name no preview or dev origin", () => {
    const outDir = mkdtempSync(path.join("/var/tmp", "one-apps-prod-build."));
    try {
      const env: Record<string, string | undefined> = { ...process.env, VITE_ONE_APPS: "true", NODE_ENV: "production" };
      delete env.CF_PAGES_BRANCH;
      const build = Bun.spawnSync(["bunx", "vite", "build", "--mode", "production", "--outDir", outDir, "--emptyOutDir"], { cwd: frontend, env, stdout: "pipe", stderr: "pipe" });
      expect(build.exitCode, build.stderr.toString()).toBe(0);
      const shipped = files(outDir).filter((file) => /\.(js|mjs|cjs|css|html|json|webmanifest|txt|md)$/.test(file) || path.basename(file).startsWith("_"));
      const bundle = shipped.map((file) => readFileSync(file, "utf8")).join("\n");
      // The registry is in the bundle, so the absence below is not vacuous.
      expect(bundle).toContain("https://explorer.tinycloud.xyz");
      expect(bundle).toContain("https://share.tinycloud.xyz");
      expect(bundle).toContain("https://rocinante-ledger.pages.dev");
      for (const pattern of FORBIDDEN) {
        expect(shipped.filter((file) => pattern.test(readFileSync(file, "utf8"))).map((file) => path.relative(outDir, file))).toEqual([]);
      }
      expect(readFileSync(path.join(outDir, "_headers"), "utf8")).not.toMatch(/localhost|pages\.dev/);
      // The dev harness page (frontend/one-apps-dev.html, src/apps/dev) is served only by the dev server.
      expect(files(outDir).map((file) => path.relative(outDir, file)).filter((file) => /one-apps-dev|apps\/dev\//.test(file))).toEqual([]);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  }, 600_000);
});
