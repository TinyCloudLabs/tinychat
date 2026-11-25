import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { connectorNamedKeyWritesEnabled } from "./namedKeyWrites";

// Production web builds read their VITE_* values only from [env.production.vars] in wrangler.toml
// (docs/deployment.md). Saving a connector key under its own encryption key (TC-3284) is on in
// production and off in previews, which take the top-level [vars].
const wrangler = Bun.TOML.parse(readFileSync(new URL("../../../../wrangler.toml", import.meta.url), "utf8")) as {
  vars: Record<string, string>;
  env: { production: { vars: Record<string, string> } };
};

describe("wrangler.toml and connector named-key writes", () => {
  test("production builds turn it on", () => {
    expect(wrangler.env.production.vars.VITE_CONNECTOR_NAMED_KEY_WRITES).toBe("true");
    expect(connectorNamedKeyWritesEnabled(wrangler.env.production.vars, null)).toBe(true);
  });

  test("preview builds leave it off", () => {
    expect(wrangler.vars).not.toHaveProperty("VITE_CONNECTOR_NAMED_KEY_WRITES");
    expect(connectorNamedKeyWritesEnabled(wrangler.vars, null)).toBe(false);
  });

  test("phone and desktop builds read frontend/.env.production, which turns it on", () => {
    const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), "utf8");
    const productionEnv = Object.fromEntries(
      read("../../../.env.production").split("\n").filter((line) => /^[A-Z_]+=/.test(line)).map((line) => {
        const at = line.indexOf("=");
        return [line.slice(0, at), line.slice(at + 1).trim()];
      }),
    );
    expect(productionEnv.VITE_CONNECTOR_NAMED_KEY_WRITES).toBe("true");
    expect(connectorNamedKeyWritesEnabled(productionEnv, null)).toBe(true);
    // The desktop app builds the web bundle with `vite build`, which loads .env.production in production mode.
    const tauri = JSON.parse(read("../../../../desktop/src-tauri/tauri.conf.json")) as { build: { beforeBuildCommand: string } };
    expect(tauri.build.beforeBuildCommand).toBe("bun run --cwd ../frontend build");
  });
});
