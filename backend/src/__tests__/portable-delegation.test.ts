import { describe, expect, it } from "bun:test";
import {
  activatePortableDelegation,
  MAX_ACTIVATABLE_RESOURCES,
} from "../portable-delegation.js";

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
    // `.kv` is the W4 guard wrapping the kv resource's handle, NOT the sql resource's — note
    // that asserting `toBe(kvAccess.kv)` here would be VACUOUS, because `access` IS `kvAccess`
    // and the assignment mutates both sides of that comparison at once.
    expect((access as any).kv.service).toBe("kv");
    expect((access as any).sql).toBe(sqlAccess.sql);
  });

  it("resolves a symbolic resource space to the delegation's concrete space", async () => {
    const calls: any[] = [];
    const node = {
      useDelegation: async (delegation: any) => {
        calls.push(delegation);
        return { kv: {} };
      },
    };
    const spaceId =
      "tinycloud:pkh:eip155:1:0x0000000000000000000000000000000000000001:applications";

    await activatePortableDelegation(node as any, {
      spaceId,
      expiry: new Date(Date.now() + 60_000),
      resources: [
        {
          service: "tinycloud.kv",
          space: "applications",
          path: "xyz.tinycloud.tinychat/threads/",
          actions: ["tinycloud.kv/get"],
        },
      ],
    } as any);

    expect(calls).toHaveLength(1);
    expect(calls[0].spaceId).toBe(spaceId);
    expect(calls[0].resources[0].space).toBe(spaceId);
  });

  // §9.3, derived from real production data (shared-eliza probe 2026-06-14) and stated
  // unconditionally everywhere else in the design: TinyCloud DROPS concurrent responses on the
  // same space. The previous `await Promise.all(...)` fan-out fired one `useDelegation` per
  // resource simultaneously against one space. This test fails on that code and passes on the
  // sequential loop — the multi-resource test above passes either way, which is why the defect
  // shipped green.
  it("activates resources STRICTLY SEQUENTIALLY — never concurrently on one space (§9.3)", async () => {
    let active = 0;
    let maxActive = 0;
    const node = {
      useDelegation: async (delegation: any) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 1));
        active -= 1;
        return delegation.resources?.[0]?.service === "tinycloud.sql"
          ? { kv: {}, sql: {} }
          : { kv: {} };
      },
    };

    await activatePortableDelegation(node as any, {
      expiry: new Date(Date.now() + 60_000),
      resources: [
        {
          service: "tinycloud.kv",
          space: "applications",
          path: "xyz.tinycloud.tinychat/connectors/",
          actions: ["tinycloud.kv/get", "tinycloud.kv/put"],
        },
        {
          service: "tinycloud.sql",
          space: "applications",
          path: "xyz.tinycloud.tinychat/connectors",
          actions: ["tinycloud.sql/read", "tinycloud.sql/write"],
        },
      ],
    } as any);

    expect(maxActive).toBe(1);
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

  // §3.2a edit 2 — an in-process bound on what this process's writer holds, clamped to the policy.
  // It does not restrict the delegatee, which invokes against the node on the underlying chain.
  it("clamps activation to the intersection of the backend policy and the granted resources", async () => {
    const calls: any[] = [];
    const node = {
      useDelegation: async (delegation: any) => {
        calls.push(delegation);
        return { kv: { path: delegation.path } };
      },
    };

    await activatePortableDelegation(
      node as any,
      {
        expiry: new Date(Date.now() + 60_000),
        resources: [
          {
            service: "tinycloud.kv",
            space: "applications",
            path: "xyz.tinycloud.tinychat/connectors/",
            actions: ["get", "put", "del", "list"],
          },
          {
            service: "tinycloud.kv",
            space: "applications",
            path: "xyz.tinycloud.tinychat/threads/",
            actions: ["get", "put", "del", "list"],
          },
        ],
      } as any,
      {
        policy: [
          {
            service: "tinycloud.kv",
            space: "applications",
            path: "xyz.tinycloud.tinychat/connectors/",
            actions: ["tinycloud.kv/get", "tinycloud.kv/put", "tinycloud.kv/list"],
          },
        ],
      },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe("xyz.tinycloud.tinychat/connectors/");
    expect(calls[0].actions).toEqual([
      "tinycloud.kv/get",
      "tinycloud.kv/put",
      "tinycloud.kv/list",
    ]);
  });

  it("narrows a granted path broader than the policy down to the policy path", async () => {
    const calls: any[] = [];
    const node = {
      useDelegation: async (delegation: any) => {
        calls.push(delegation);
        return { kv: { path: delegation.path } };
      },
    };

    await activatePortableDelegation(
      node as any,
      {
        expiry: new Date(Date.now() + 60_000),
        resources: [
          {
            service: "tinycloud.kv",
            space: "applications",
            path: "",
            actions: ["get", "put", "del", "list"],
          },
        ],
      } as any,
      {
        policy: [
          {
            service: "tinycloud.kv",
            space: "applications",
            path: "xyz.tinycloud.tinychat/connectors/",
            actions: ["tinycloud.kv/get", "tinycloud.kv/put"],
          },
        ],
      },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe("xyz.tinycloud.tinychat/connectors/");
    expect(calls[0].actions).toEqual(["tinycloud.kv/get", "tinycloud.kv/put"]);
  });

  it("throws instead of activating unclamped when nothing survives the policy clamp", async () => {
    const calls: unknown[] = [];
    const node = {
      useDelegation: async (delegation: any) => {
        calls.push(delegation);
        return { kv: {} };
      },
    };

    await expect(
      activatePortableDelegation(
        node as any,
        {
          expiry: new Date(Date.now() + 60_000),
          resources: [
            {
              service: "tinycloud.kv",
              space: "applications",
              path: "xyz.tinycloud.tinychat/threads/",
              actions: ["get", "put", "del", "list"],
            },
          ],
        } as any,
        {
          policy: [
            {
              service: "tinycloud.kv",
              space: "applications",
              path: "xyz.tinycloud.tinychat/connectors/",
              actions: ["tinycloud.kv/get", "tinycloud.kv/put"],
            },
          ],
        },
      ),
    ).rejects.toThrow("no resources that survive clamping to the backend policy");
    expect(calls).toEqual([]);
  });

  // The single-resource cases above all passed while the clamp was defeated, which is why this
  // shipped: a bundle carrying ONE legitimate entry plus ONE escaping entry satisfied both
  // accept-side checks (coverage true, offending list EMPTY) and activated the escaping entry
  // verbatim — `resources` is an unsigned, rewritable top-level field (§9.2), so no signature
  // forgery is involved.
  it("drops an escaping resource carried alongside a legitimate one", async () => {
    const calls: any[] = [];
    const node = {
      useDelegation: async (delegation: any) => {
        calls.push(delegation);
        return { kv: { path: delegation.path } };
      },
    };
    const policy = [
      {
        service: "tinycloud.kv",
        space: "applications",
        path: "xyz.tinycloud.tinychat/threads/",
        actions: ["tinycloud.kv/get", "tinycloud.kv/put", "tinycloud.kv/del", "tinycloud.kv/list"],
      },
    ];

    await activatePortableDelegation(
      node as any,
      {
        expiry: new Date(Date.now() + 60_000),
        spaceId: "tinycloud:pkh:eip155:1:0xowner",
        resources: [
          {
            service: "tinycloud.kv",
            space: "applications",
            path: "xyz.tinycloud.tinychat/threads/",
            actions: ["get", "put", "del", "list"],
          },
          {
            service: "tinycloud.kv",
            // Normalizes to `applications` on the SDK's last-colon rule…
            space: "tinycloud:0xdeadbeef00000000000000000000000000001234:applications",
            // …and `startsWith` the policy path, so the prefix predicate called it INSIDE.
            path: "xyz.tinycloud.tinychat/threads/../../../",
            actions: ["get", "put", "del", "list"],
          },
        ],
      } as any,
      { policy },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe("xyz.tinycloud.tinychat/threads/");
    expect(calls[0].spaceId).toBe("tinycloud:pkh:eip155:1:0xowner");
  });

  it("never re-emits a granted space that is not the delegation's own", async () => {
    const calls: any[] = [];
    const node = {
      useDelegation: async (delegation: any) => {
        calls.push(delegation);
        return { kv: {} };
      },
    };
    const policy = [
      {
        service: "tinycloud.kv",
        space: "applications",
        path: "xyz.tinycloud.tinychat/threads/",
        actions: ["tinycloud.kv/get"],
      },
    ];
    const bundle = (space: string) =>
      ({
        expiry: new Date(Date.now() + 60_000),
        spaceId: "tinycloud:pkh:eip155:1:0xowner",
        resources: [
          {
            service: "tinycloud.kv",
            space,
            path: "xyz.tinycloud.tinychat/threads/",
            actions: ["get"],
          },
        ],
      }) as any;

    // A full space id that is not this delegation's is refused outright…
    for (const space of [
      "tinycloud:applications",
      "tinycloud:pkh:eip155:1:applications",
      "tinycloud:0xdeadbeef00000000000000000000000000001234:applications",
    ]) {
      await expect(
        activatePortableDelegation(node as any, bundle(space), { policy }),
      ).rejects.toThrow("no resources that survive clamping to the backend policy");
    }
    expect(calls).toEqual([]);

    // …and the policy's symbolic space is resolved to the delegation's concrete space id in both
    // activation fields, which is the only space the node was ever going to authorize.
    await activatePortableDelegation(node as any, bundle("applications"), { policy });
    expect(calls).toHaveLength(1);
    expect(calls[0].spaceId).toBe("tinycloud:pkh:eip155:1:0xowner");
    expect(calls[0].resources[0].space).toBe("tinycloud:pkh:eip155:1:0xowner");
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

  // §3.5 (S2b). The deleted arm was `if (delegations.length === 1) return
  // node.useDelegation(delegations[0])` — activation straight from the unsigned top level with
  // no clamp, reached exactly when extraction found nothing to trust. Both live callers pass a
  // policy, so this was latent; §9.2 requires the arm gone because after S2b an empty projection
  // means REJECTED, not "activate unscoped".
  it("throws — never activates unclamped — on a zero projection even with NO policy (S2b)", async () => {
    const calls: unknown[] = [];
    const node = {
      useDelegation: async (delegation: any) => {
        calls.push(delegation);
        return { kv: {} };
      },
    };
    const bundle = {
      expiry: new Date(Date.now() + 60_000),
      spaceId: "tinycloud:pkh:eip155:1:0xowner",
      path: "",
      actions: ["tinycloud.kv/get", "tinycloud.kv/put", "tinycloud.kv/del"],
      resources: [],
    } as any;

    // No policy argument at all — the shape that used to fall through to the fallback.
    await expect(activatePortableDelegation(node as any, bundle, {})).rejects.toThrow(
      "does not include activatable resources",
    );
    // …and with a bundle whose resources are present but unreadable, same answer.
    await expect(
      activatePortableDelegation(node as any, { ...bundle, resources: undefined }, {}),
    ).rejects.toThrow("does not include activatable resources");
    expect(calls).toEqual([]);
  });

  // W4 (§3.5). With exactly ONE kv resource `createKvRouter` was never constructed and
  // `kvPathContains` never ran, so the writer held the RAW activated handle and containment
  // rested entirely on node-side authorization — which §9.3 says must never be the only control.
  it("W4: the activated kv handle refuses an out-of-grant key IN-PROCESS, before any node call", async () => {
    const gets: string[] = [];
    const node = {
      useDelegation: async () => ({
        kv: {
          get: async (key: string) => {
            gets.push(key);
            return { ok: true };
          },
          put: async (key: string) => {
            gets.push(key);
            return { ok: true };
          },
          list: async () => ({ ok: true }),
        },
      }),
    };
    const policy = [
      {
        service: "tinycloud.kv",
        space: "applications",
        path: "xyz.tinycloud.tinychat/connectors/",
        actions: ["tinycloud.kv/get", "tinycloud.kv/put"],
      },
    ];

    const access = await activatePortableDelegation(
      node as any,
      {
        expiry: new Date(Date.now() + 60_000),
        spaceId: "tinycloud:pkh:eip155:1:0xowner",
        resources: [
          {
            service: "tinycloud.kv",
            space: "applications",
            path: "xyz.tinycloud.tinychat/connectors/",
            actions: ["get", "put"],
          },
        ],
      } as any,
      { policy },
    );

    // Inside the grant: forwarded as the FULL key with the handle's own prefixing suppressed —
    // the same convention the multi-resource router already used, now used for one resource too.
    await (access as any).kv.get("xyz.tinycloud.tinychat/connectors/meetings/01ABC");
    expect(gets).toEqual(["xyz.tinycloud.tinychat/connectors/meetings/01ABC"]);

    // Outside it: throws in-process, and the underlying handle is never reached.
    expect(() => (access as any).kv.get("xyz.tinycloud.tinychat/threads/leak")).toThrow(
      /does not match any activated portable delegation resource path/,
    );
    expect(() => (access as any).kv.put("secrets/xyz.tinycloud.tinychat/api-key", 1)).toThrow(
      /does not match any activated portable delegation resource path/,
    );
    // §6.1's "full path, not a relative one" failure mode, caught where the design said it was.
    expect(() => (access as any).kv.get("connectors/meetings/01ABC")).toThrow(
      /does not match any activated portable delegation resource path/,
    );
    expect(gets).toHaveLength(1);
  });

  // The one verb that used to skip the guard: `list()` with no prefix went straight to the raw
  // handle, scoped only by the node-side `new KVService({ prefix })` W4 exists not to rely on.
  it("W4: a bare kv.list() is resolved to the grant path and forwarded EXPLICITLY", async () => {
    const lists: unknown[] = [];
    const node = {
      useDelegation: async () => ({
        kv: {
          list: async (options: unknown) => {
            lists.push(options);
            return { ok: true };
          },
        },
      }),
    };
    const policy = [
      {
        service: "tinycloud.kv",
        space: "applications",
        path: "xyz.tinycloud.tinychat/connectors/",
        actions: ["tinycloud.kv/list"],
      },
    ];

    const access = await activatePortableDelegation(
      node as any,
      {
        expiry: new Date(Date.now() + 60_000),
        spaceId: "tinycloud:pkh:eip155:1:0xowner",
        resources: [
          {
            service: "tinycloud.kv",
            space: "applications",
            path: "xyz.tinycloud.tinychat/connectors/",
            actions: ["list"],
          },
        ],
      } as any,
      { policy },
    );

    await (access as any).kv.list();
    expect(lists).toEqual([{ prefix: "xyz.tinycloud.tinychat/connectors" }]);

    // And a hostile prefix is still refused, in-process, before the node is reached.
    expect(() => (access as any).kv.list({ prefix: "../../" })).toThrow(/not canonical/);
    expect(() => (access as any).kv.list({ prefix: "xyz.tinycloud.tinychat/threads/" })).toThrow(
      /does not match any activated portable delegation resource path/,
    );
    expect(lists).toHaveLength(1);
  });

  // §3.5 (S2e). `assertSupportedMultiResourceShape` capped only sql/duckdb/hooks at one each and
  // left the KV count unbounded — and after the Promise.all → sequential fix each resource is one
  // more SERIALIZED node round trip inside a single HTTP request, against the ~0.5 writes/sec
  // node §9.3 budgets across all users and apps.
  it("S2e: rejects a bundle activating more than MAX_ACTIVATABLE_RESOURCES", async () => {
    const calls: unknown[] = [];
    const node = {
      useDelegation: async (delegation: any) => {
        calls.push(delegation);
        return { kv: {} };
      },
    };

    await expect(
      activatePortableDelegation(node as any, {
        expiry: new Date(Date.now() + 60_000),
        resources: Array.from({ length: MAX_ACTIVATABLE_RESOURCES + 1 }, (_, i) => ({
          service: "tinycloud.kv",
          space: "applications",
          path: `xyz.tinycloud.tinychat/connectors/${i}/`,
          actions: ["tinycloud.kv/get"],
        })),
      } as any),
    ).rejects.toThrow(/the maximum is 4/);
    expect(calls).toEqual([]);
  });

  // The literal, not just "some cap": `docs/connector-webhooks-kv-write-budget.md` §2.3 computes
  // its "accept + activate: ≤4 sequential node calls" row at 4 and says S2e must pin it. Raising
  // the constant without redoing that analysis voids the row, so the number is asserted directly.
  it("S2e: the activation cap is pinned at the write budget's literal of 4", () => {
    expect(MAX_ACTIVATABLE_RESOURCES).toBe(4);
  });

  // W4 (§3.5), the KEY half of the rule `isCanonicalResourcePath` already applies to grants.
  // `kvPathContains` is a pure `startsWith` over unresolved strings, so anything beginning with
  // the grant prefix passed regardless of what followed — and the key went to the node verbatim.
  it("W4: the activated kv handle refuses a NON-CANONICAL key before any node call", async () => {
    const seen: string[] = [];
    const node = {
      useDelegation: async () => ({
        kv: {
          get: async (key: string) => {
            seen.push(key);
            return { ok: true };
          },
          put: async (key: string) => {
            seen.push(key);
            return { ok: true };
          },
          list: async (options: any) => {
            seen.push(`list:${options?.prefix ?? ""}`);
            return { ok: true };
          },
        },
      }),
    };
    const policy = [
      {
        service: "tinycloud.kv",
        space: "applications",
        path: "xyz.tinycloud.tinychat/threads/",
        actions: ["tinycloud.kv/get", "tinycloud.kv/put", "tinycloud.kv/list"],
      },
    ];

    const access = await activatePortableDelegation(
      node as any,
      {
        expiry: new Date(Date.now() + 60_000),
        spaceId: "tinycloud:pkh:eip155:1:0xowner",
        resources: [
          {
            service: "tinycloud.kv",
            space: "applications",
            path: "xyz.tinycloud.tinychat/threads/",
            actions: ["get", "put", "list"],
          },
        ],
      } as any,
      { policy },
    );

    for (const key of [
      "xyz.tinycloud.tinychat/threads/../../../secrets/master",
      "xyz.tinycloud.tinychat/threads/..%2F..%2Fsecrets",
      "xyz.tinycloud.tinychat/threads/./x",
      "xyz.tinycloud.tinychat/threads//x",
      "xyz.tinycloud.tinychat/threads/a\\b",
    ]) {
      expect(() => (access as any).kv.put(key, 1)).toThrow(/is not canonical/);
      expect(() => (access as any).kv.get(key)).toThrow(/is not canonical/);
    }
    // …and the same rule on the list path, which builds its own prefix.
    expect(() => (access as any).kv.list({ prefix: "xyz.tinycloud.tinychat/threads/../.." })).toThrow(
      /is not canonical/,
    );
    // Nothing reached the node.
    expect(seen).toEqual([]);

    // The canonical key still works, trailing slash and all.
    await (access as any).kv.get("xyz.tinycloud.tinychat/threads/01ABC");
    await (access as any).kv.list({ prefix: "xyz.tinycloud.tinychat/threads/" });
    expect(seen).toEqual([
      "xyz.tinycloud.tinychat/threads/01ABC",
      "list:xyz.tinycloud.tinychat/threads",
    ]);
  });

  // §3.2a, top-level `spaceId` half. `activateResource` reads `delegation.spaceId` as the
  // invocation target whenever the clamped resource carries no `tinycloud:` space — and the clamp
  // re-emits the policy's bare `applications`, so it ALWAYS does. Re-checked here (not only at
  // accept) because the middleware and the drain gate re-activate the STORED bundle.
  it("§3.2a: refuses to activate a bundle whose spaceId is not the activating address's", async () => {
    const calls: unknown[] = [];
    const node = {
      useDelegation: async (delegation: any) => {
        calls.push(delegation);
        return { kv: {} };
      },
    };
    const policy = [
      {
        service: "tinycloud.kv",
        space: "applications",
        path: "xyz.tinycloud.tinychat/threads/",
        actions: ["tinycloud.kv/get"],
      },
    ];
    const owner = "0xAAaaAAaaAAaaAAaaAAaaAAaaAAaaAAaaAAaaAAaa";
    const bundle = (spaceId: string | undefined) =>
      ({
        expiry: new Date(Date.now() + 60_000),
        ...(spaceId === undefined ? {} : { spaceId }),
        resources: [
          {
            service: "tinycloud.kv",
            space: "applications",
            path: "xyz.tinycloud.tinychat/threads/",
            actions: ["get"],
          },
        ],
      }) as any;

    for (const spaceId of [
      "tinycloud:pkh:eip155:1:0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb:applications",
      // Not a parseable pkh space id: uncomparable ⇒ refused, not interpreted.
      "tinycloud:0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb:applications",
      "tinycloud:applications",
      // A bare space NAME names no owner — and is forwarded VERBATIM as the invocation's
      // `spaceId`, so "names no owner" is not "cannot steer": what the node resolves it against
      // is the guess this rule exists not to make. Uncomparable ⇒ refused.
      "applications",
    ]) {
      await expect(
        activatePortableDelegation(node as any, bundle(spaceId), { policy, ownerAddress: owner }),
      ).rejects.toThrow(/do not belong to the activating address/);
    }
    expect(calls).toEqual([]);

    // The owner's own space id activates, case-insensitively, and so does an absent one (there
    // is then no attacker-chosen fallback target for `activateResource` to read).
    for (const spaceId of [
      `tinycloud:pkh:eip155:1:${owner.toLowerCase()}:applications`,
      `tinycloud:pkh:eip155:1:${owner}`,
      undefined,
    ]) {
      await activatePortableDelegation(node as any, bundle(spaceId), {
        policy,
        ownerAddress: owner,
      });
    }
    expect(calls).toHaveLength(3);
  });
});
