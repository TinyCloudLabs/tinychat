import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  extractSessionToken,
  resolveRealAuthCommandEnv,
  resolveRealAuthConfig,
} from "./real-auth-support.ts";

const repoRoot = new URL("..", import.meta.url).pathname;

describe("real auth harness package scripts", () => {
  test("exposes one local interactive real-auth command", () => {
    const rootPkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
    const testPkg = JSON.parse(readFileSync(join(repoRoot, "test/package.json"), "utf8"));

    expect(rootPkg.scripts["test:real-auth"]).toBe("bun run --cwd test real-auth");
    expect(rootPkg.scripts["test:real-auth:setup"]).toBeUndefined();
    expect(rootPkg.scripts["test:workflows"]).toBeUndefined();
    expect(testPkg.scripts["real-auth"]).toBe("bun real-auth-manual.ts");
    expect(testPkg.scripts["real-auth:setup"]).toBeUndefined();
  });

  test("does not keep the optional CI replay workflow surface", () => {
    const ciWorkflow = readFileSync(join(repoRoot, ".github/workflows/ci.yml"), "utf8");

    expect(existsSync(join(repoRoot, ".github/workflows/real-auth.yml"))).toBe(false);
    expect(existsSync(join(repoRoot, "scripts/workflows.test.ts"))).toBe(false);
    expect(ciWorkflow).not.toContain("Workflow contracts");
    expect(ciWorkflow).not.toContain("test:workflows");
    expect(ciWorkflow).not.toContain("real-auth-replay");
  });

  test("manual runner keeps Playwright in the live browser session", () => {
    const runnerPath = join(repoRoot, "test/real-auth-manual.ts");
    expect(existsSync(runnerPath)).toBe(true);

    const manualRunner = readFileSync(runnerPath, "utf8");

    expect(manualRunner).toContain("Complete the real OpenKey/TinyCloud sign-in");
    expect(manualRunner).toContain("Verified delegated probe");
    expect(manualRunner).toContain(
      "WebAuthn is not supported on sites with TLS certificate errors",
    );
    expect(manualRunner).toContain("fetchProbe");
    expect(manualRunner).not.toContain("storageState:");
    expect(manualRunner).not.toContain("ignoreHTTPSErrors");
    expect(manualRunner).not.toContain("writePrivateJsonFile");
    expect(manualRunner).not.toContain("REAL_AUTH_IGNORE_HTTPS_ERRORS");
  });
});

describe("real auth manual config", () => {
  test("defaults to app-starter local ports without fixture files", () => {
    const config = resolveRealAuthConfig({ cwd: repoRoot, env: {} });

    expect(config.frontendUrl).toBe("http://localhost:5186");
    expect(config.backendUrl).toBe("http://localhost:3014");
    expect("fixturePath" in config).toBe(false);
    expect("metadataPath" in config).toBe(false);
    expect(config.probeValue).toContain("TinyCloud real-auth manual");
    expect(config.browserChannel).toBeUndefined();
    expect(config.userDataDir).toBeUndefined();
  });

  test("lets callers override urls and the manual-login browser profile", () => {
    const config = resolveRealAuthConfig({
      cwd: repoRoot,
      env: {
        FRONTEND_URL: "https://localhost:4443",
        BACKEND_URL: "http://localhost:3999",
        REAL_AUTH_BROWSER: "chrome",
        REAL_AUTH_USER_DATA_DIR: ".auth/chrome-profile",
      },
    });

    expect(config.frontendUrl).toBe("https://localhost:4443");
    expect(config.backendUrl).toBe("http://localhost:3999");
    expect(config.browserChannel).toBe("chrome");
    expect(config.userDataDir).toBe(join(repoRoot, ".auth/chrome-profile"));
  });

  test("auto-wires mkcert HTTPS defaults for command runs when local certs exist", async () => {
    const root = await mkdtemp(join(tmpdir(), "tinyboilerplate-real-auth-"));
    try {
      await mkdir(join(root, "frontend"), { recursive: true });
      await writeFile(join(root, "frontend/localhost.pem"), "cert");
      await writeFile(join(root, "frontend/localhost-key.pem"), "key");
      await mkdir(join(root, "mkcert"), { recursive: true });
      await writeFile(join(root, "mkcert/rootCA.pem"), "ca");

      const env = resolveRealAuthCommandEnv({
        cwd: root,
        env: { REAL_AUTH_MKCERT_CAROOT: join(root, "mkcert") },
      });

      expect(env.FRONTEND_URL).toBe("https://localhost:5186");
      expect(env.BACKEND_URL).toBe("https://localhost:3014");
      expect(env.NODE_EXTRA_CA_CERTS).toBe(join(root, "mkcert/rootCA.pem"));
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("does not auto-wire HTTPS URLs from certificate files without a mkcert root CA", async () => {
    const root = await mkdtemp(join(tmpdir(), "tinyboilerplate-real-auth-"));
    try {
      await mkdir(join(root, "frontend"), { recursive: true });
      await writeFile(join(root, "frontend/localhost.pem"), "cert");
      await writeFile(join(root, "frontend/localhost-key.pem"), "key");

      const env = resolveRealAuthCommandEnv({
        cwd: root,
        env: { REAL_AUTH_MKCERT_CAROOT: join(root, "missing-mkcert") },
      });

      expect(env.FRONTEND_URL).toBeUndefined();
      expect(env.BACKEND_URL).toBeUndefined();
      expect(env.NODE_EXTRA_CA_CERTS).toBeUndefined();
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("does not replace explicit command URLs or CA settings", async () => {
    const root = await mkdtemp(join(tmpdir(), "tinyboilerplate-real-auth-"));
    try {
      await mkdir(join(root, "frontend"), { recursive: true });
      await writeFile(join(root, "frontend/localhost.pem"), "cert");
      await writeFile(join(root, "frontend/localhost-key.pem"), "key");

      const env = resolveRealAuthCommandEnv({
        cwd: root,
        env: {
          BACKEND_URL: "http://localhost:3999",
          FRONTEND_URL: "http://localhost:4999",
          NODE_EXTRA_CA_CERTS: "/tmp/custom-ca.pem",
        },
      });

      expect(env.FRONTEND_URL).toBe("http://localhost:4999");
      expect(env.BACKEND_URL).toBe("http://localhost:3999");
      expect(env.NODE_EXTRA_CA_CERTS).toBe("/tmp/custom-ca.pem");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});

describe("live browser session extraction", () => {
  test("extracts the app-starter bearer token from the current browser context state", () => {
    const token = extractSessionToken({
      cookies: [],
      origins: [
        {
          origin: "http://localhost:5186",
          localStorage: [
            {
              name: "xyz.tinycloud.tinychat:session",
              value: JSON.stringify({
                address: "0x123",
                expiresAt: Date.now() + 60_000,
                token: "signed-session",
              }),
            },
          ],
        },
      ],
    });

    expect(token).toBe("signed-session");
  });
});
