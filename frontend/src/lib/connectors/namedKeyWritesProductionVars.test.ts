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
});
