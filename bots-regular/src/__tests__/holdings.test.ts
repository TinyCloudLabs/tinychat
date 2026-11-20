import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { regularConfig } from "../config";

const SRC = resolve(import.meta.dir, "..");
const REPO = resolve(SRC, "..", "..");

/** Every module the service and its gateway load, followed from their entry points. */
function moduleGraph(entries: string[]): { files: Set<string>; packages: Set<string> } {
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  const files = new Set<string>();
  const packages = new Set<string>();
  const queue = [...entries];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (files.has(file)) continue;
    files.add(file);
    for (const { path } of transpiler.scanImports(readFileSync(file, "utf8"))) {
      if (!path.startsWith(".")) {
        packages.add(path);
        continue;
      }
      const target = resolve(dirname(file), path);
      queue.push(existsSync(`${target}.ts`) ? `${target}.ts` : target);
    }
  }
  return { files, packages };
}

describe("what the regular service holds", () => {
  test("it loads only its own code, the private runtime's bot code and the sandbox library: nothing that opens an owner's space", () => {
    const { files, packages } = moduleGraph([join(SRC, "main.ts"), join(SRC, "gateway-main.ts")]);
    for (const file of files) {
      expect(file.startsWith(join(REPO, "bots-regular", "src")) || file.startsWith(join(REPO, "bots", "src"))).toBe(true);
    }
    for (const name of packages) {
      expect(name.startsWith("node:") || ["bun", "viem", "@phala/aci-verifier/runtime", "@getenergy/gke-sandboxes"].includes(name)).toBe(true);
    }
  });

  test("it needs its own secret: the private service's secret does not configure it", () => {
    const env = {
      BOTS_SERVICE_SECRET: "a".repeat(64),
      BOTS_REGULAR_PROVIDER: "local",
      BOTS_REGULAR_LOCAL_ROOT: "/var/tmp/unused",
      BOTS_REGULAR_LOCAL_AGENT: "agent",
      BOTS_REGULAR_GATEWAY_ORIGIN: "http://gateway:8081",
    };
    expect(() => regularConfig(env)).toThrow("BOTS_REGULAR_SERVICE_SECRET is not set");
    expect(regularConfig({ ...env, BOTS_REGULAR_SERVICE_SECRET: "b".repeat(64) }).serviceSecret).toBe("b".repeat(64));
  });

  test("a real sandbox host only takes an image pinned by digest", () => {
    const env = {
      BOTS_REGULAR_SERVICE_SECRET: "b".repeat(64),
      BOTS_REGULAR_PROVIDER: "gke",
      BOTS_REGULAR_GATEWAY_ORIGIN: "http://gateway:8081",
    };
    expect(() => regularConfig({ ...env, BOTS_REGULAR_SANDBOX_IMAGE: "ghcr.io/x/sandbox:latest" })).toThrow("pinned by digest");
    expect(regularConfig({ ...env, BOTS_REGULAR_SANDBOX_IMAGE: `ghcr.io/x/sandbox@sha256:${"0".repeat(64)}` }).provider)
      .toMatchObject({ kind: "gke", namespace: "sandboxes", apiUrl: "https://kubernetes.default.svc" });
  });
});
