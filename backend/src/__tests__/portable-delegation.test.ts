import { describe, expect, it } from "bun:test";
import { activatePortableDelegation } from "../portable-delegation.js";

describe("activatePortableDelegation", () => {
  it("activates each resource in a multi-resource portable delegation", async () => {
    const calls: unknown[] = [];
    const kvAccess = { kv: { service: "kv" } };
    const sqlAccess = { kv: { service: "sql-scoped-kv" }, sql: { service: "sql" } };
    const node = {
      useDelegation: async (delegation: any) => {
        calls.push(delegation);
        const service = delegation.resources?.[0]?.service;
        return service === "tinycloud.sql" ? sqlAccess : kvAccess;
      },
    };

    const access = await activatePortableDelegation(
      node as any,
      {
        expiry: new Date(Date.now() + 60_000),
        resources: [
          {
            service: "tinycloud.kv",
            space: "applications",
            path: "xyz.tinycloud.tinychat/probe/",
            actions: ["tinycloud.kv/get", "tinycloud.kv/put"],
          },
          {
            service: "tinycloud.sql",
            space: "applications",
            path: "xyz.tinycloud.tinychat/auxiliary_index",
            actions: ["tinycloud.sql/read", "tinycloud.sql/write"],
          },
        ],
      } as any,
    );

    expect(calls).toHaveLength(2);
    expect(calls.map((call: any) => call.path)).toEqual([
      "xyz.tinycloud.tinychat/probe/",
      "xyz.tinycloud.tinychat/auxiliary_index",
    ]);
    expect((access as any).kv).toBe(kvAccess.kv);
    expect((access as any).kv.service).toBe("kv");
    expect((access as any).sql).toBe(sqlAccess.sql);
  });

  it("routes same-service KV resources by path instead of leaving the last handle active", async () => {
    const calls: unknown[] = [];
    const kvGets: Array<{ label: string; key: string; options: unknown }> = [];
    const kvAccess = (label: string) => ({
      kv: {
        get: async (key: string, options?: unknown) => {
          kvGets.push({ label, key, options });
          return { ok: true, data: { data: label, headers: {} } };
        },
      },
    });
    const node = {
      useDelegation: async (delegation: any) => {
        calls.push(delegation);
        return delegation.path.includes("secrets/")
          ? kvAccess("secrets-space")
          : kvAccess("app-data");
      },
    };

    const access = await activatePortableDelegation(
      node as any,
      {
        expiry: new Date(Date.now() + 60_000),
        resources: [
          {
            service: "tinycloud.kv",
            space: "applications",
            path: "xyz.tinycloud.tinychat/probe/",
            actions: ["tinycloud.kv/get", "tinycloud.kv/put"],
          },
          {
            service: "tinycloud.kv",
            space: "tinycloud:space:secrets",
            path: "secrets/xyz.tinycloud.tinychat/",
            actions: ["tinycloud.kv/get"],
          },
        ],
      } as any,
    );

    await (access as any).kv.get("xyz.tinycloud.tinychat/probe/value");
    await (access as any).kv.get("secrets/xyz.tinycloud.tinychat/api-key");

    expect(calls).toHaveLength(2);
    expect(kvGets.map(({ label }) => label)).toEqual(["app-data", "secrets-space"]);
    expect(kvGets.map(({ key }) => key)).toEqual([
      "xyz.tinycloud.tinychat/probe/value",
      "secrets/xyz.tinycloud.tinychat/api-key",
    ]);
    expect(kvGets.map(({ options }) => options)).toEqual([{ prefix: "" }, { prefix: "" }]);
  });

  it("rejects multiple same-service SQL resources instead of exposing the wrong handle", async () => {
    const node = {
      useDelegation: async (delegation: any) => ({
        sql: { path: delegation.path },
      }),
    };

    await expect(
      activatePortableDelegation(
        node as any,
        {
          expiry: new Date(Date.now() + 60_000),
          resources: [
            {
              service: "tinycloud.sql",
              space: "applications",
              path: "xyz.tinycloud.tinychat/primary_index",
              actions: ["tinycloud.sql/read"],
            },
            {
              service: "tinycloud.sql",
              space: "applications",
              path: "xyz.tinycloud.tinychat/audit_index",
              actions: ["tinycloud.sql/read"],
            },
          ],
        } as any,
      ),
    ).rejects.toThrow("Multiple tinycloud.sql resources are not supported");
  });
});
