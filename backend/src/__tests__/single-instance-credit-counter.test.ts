import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { load as loadYaml } from "js-yaml";

// The in-memory credit counter, each reply's allowance and the settlement clamp assume ONE backend
// instance (docs/credits.md, docs/connector-webhooks-single-instance.md). This fails when the
// deployment is scaled out, so adding an instance is a visible decision, not a config accident.
type Service = { deploy?: { replicas?: number }; scale?: number };
type Compose = { services?: Record<string, Service> };

test("the Phala compose file runs exactly one tinychat-backend and does not replicate it", () => {
  const compose = loadYaml(readFileSync(resolve(import.meta.dir, "../../../docker-compose.phala.yml"), "utf8")) as Compose;
  const backends = Object.keys(compose.services ?? {}).filter(name => name === "tinychat-backend" || name.startsWith("tinychat-backend-"));
  expect(backends).toEqual(["tinychat-backend"]);
  const backend = compose.services!["tinychat-backend"];
  expect(backend.deploy?.replicas ?? 1).toBe(1);
  expect(backend.scale ?? 1).toBe(1);
});
