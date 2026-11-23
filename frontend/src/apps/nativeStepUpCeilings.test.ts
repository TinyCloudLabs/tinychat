import { describe, expect, test } from "bun:test";
import openKeyCopy from "./native-step-up-ceilings.json";
import { NATIVE_STEP_UP_CEILINGS, framedApp } from "./registry";

describe("the phone app's step-up ceilings (TC-3568 S1b)", () => {
  test("read-only, inside each app's ceiling, no secrets, and equal to OpenKey's copy", () => {
    const owner = { address: "0x1111111111111111111111111111111111111111", chainId: 1 };
    const READ_ONLY = ["get", "list", "metadata", "read", "schema"];
    expect(Object.keys(NATIVE_STEP_UP_CEILINGS)).toEqual(["xyz.tinycloud.explorer", "xyz.tinycloud.account", "xyz.tinycloud.courier"]);
    for (const [id, entries] of Object.entries(NATIVE_STEP_UP_CEILINGS)) {
      const ceiling = framedApp(id)!.ceiling(owner);
      for (const entry of entries!) {
        expect(ceiling).toContainEqual(entry);
        expect(entry.permission.actions.every((action) => READ_ONLY.includes(action))).toBe(true);
        expect(["secrets", "vault"]).not.toContain(entry.permission.space);
        expect(entry.permission.service).not.toBe("tinycloud.encryption");
      }
    }
    // The one `applications` entry outside an app's own prefix: exactly Explorer's `default` database, read and schema.
    const applications = Object.values(NATIVE_STEP_UP_CEILINGS).flatMap((entries) => entries!.filter(({ permission }) => permission.space === "applications"));
    expect(applications.map(({ permission }) => permission)).toEqual([
      { service: "tinycloud.sql", space: "applications", path: "default", actions: ["read", "schema"] },
    ]);
    // OpenKey's `stepUps` shape: app → space → kv paths or sql databases, one action list per service and space.
    const asOpenKey: Record<string, Record<string, Record<string, Record<string, string[]>>>> = {};
    for (const [id, entries] of Object.entries(NATIVE_STEP_UP_CEILINGS)) {
      for (const { permission } of entries!) {
        const service = permission.service === "tinycloud.kv" ? "kv" : "sql";
        const byService = ((asOpenKey[id] ??= {})[permission.space!] ??= {});
        const slot = (byService[service] ??= { [service === "kv" ? "paths" : "databases"]: [], actions: permission.actions });
        expect(slot.actions).toEqual(permission.actions);
        slot[service === "kv" ? "paths" : "databases"].push(permission.path);
      }
    }
    expect(asOpenKey).toEqual(openKeyCopy);
  });
});
