import { afterEach, describe, expect, it } from "bun:test";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import {
  actionsFromAuthJwt,
  AGENT_CONSENT_MANIFEST,
  AGENT_DID,
  AGENT_DELEGATION_EXPIRY_MS,
  clearAgentSessionCache,
  ensureAgentSession,
  mintAgentSessionDelegations,
  TRANSCRIPT_PERMISSIONS,
} from "./agentDelegation.js";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  clearAgentSessionCache();
});

// Build a JWT-ish token with an `att` claim (only the payload segment matters).
function jwtWithAtt(att: Record<string, Record<string, unknown>>): string {
  const payload = btoa(JSON.stringify({ att })).replace(/=+$/, "");
  return `Bearer header.${payload}.sig`;
}

function fakeTcw(address = "0xUSER"): TinyCloudWeb {
  return { address: () => address, chainId: () => 1, hosts: ["https://node.tinycloud.xyz"] } as unknown as TinyCloudWeb;
}

describe("actionsFromAuthJwt", () => {
  it("recovers the full grant set from the JWT att claim", () => {
    const header = jwtWithAtt({
      "tinycloud.sql/db": { "tinycloud.sql/read": [], "tinycloud.sql/write": [] },
      "tinycloud.capabilities/cap": { "tinycloud.capabilities/read": [] },
    });
    expect(new Set(actionsFromAuthJwt(header))).toEqual(
      new Set(["tinycloud.sql/read", "tinycloud.sql/write", "tinycloud.capabilities/read"]),
    );
  });

  it("returns null for a malformed header", () => {
    expect(actionsFromAuthJwt("not-a-jwt")).toBeNull();
    expect(actionsFromAuthJwt("Bearer onlyonepart")).toBeNull();
  });
});

describe("ensureAgentSession", () => {
  it("short-circuits when the liveness probe reports active (no mint, no POST)", async () => {
    let posted = false;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") posted = true;
      return new Response(JSON.stringify({ status: "active" }), { status: 200 });
    }) as typeof fetch;

    const status = await ensureAgentSession({
      tcw: fakeTcw(),
      backendUrl: "https://api.test",
      getToken: () => "tok",
      _mint: async () => "should-not-be-called",
    });

    expect(status).toBe("active");
    expect(posted).toBe(false);
  });

  it("mints and couriers the serialized delegation when no live session exists", async () => {
    const calls: Array<{ method: string; url: string; auth: string | null; body: unknown }> = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      calls.push({
        method: init?.method ?? "GET",
        url: String(url),
        auth: new Headers(init?.headers).get("authorization"),
        body: init?.body ? JSON.parse(init.body as string) : undefined,
      });
      if (init?.method === "POST") {
        return new Response(JSON.stringify({ entityId: "e", status: "active" }), { status: 200 });
      }
      return new Response(JSON.stringify({ status: "none" }), { status: 404 });
    }) as typeof fetch;

    const status = await ensureAgentSession({
      tcw: fakeTcw(),
      backendUrl: "https://api.test",
      getToken: () => "tok",
      roomId: "thread-9",
      _mint: async () => "SERIALIZED_DELEGATION",
    });

    expect(status).toBe("active");
    const post = calls.find((c) => c.method === "POST");
    expect(post?.url).toBe("https://api.test/api/agent/session");
    expect(post?.auth).toBe("Bearer tok");
    expect(post?.body).toEqual({ serialized: "SERIALIZED_DELEGATION", roomId: "thread-9" });
  });

  it("caches an active session so the mint runs at most once", async () => {
    let mints = 0;
    globalThis.fetch = (async (_url: string, init?: RequestInit) =>
      init?.method === "POST"
        ? new Response(JSON.stringify({ status: "active" }), { status: 200 })
        : new Response(JSON.stringify({ status: "none" }), { status: 404 })) as typeof fetch;

    const deps = {
      tcw: fakeTcw("0xCACHE"),
      backendUrl: "https://api.test",
      getToken: () => "tok",
      _mint: async () => {
        mints += 1;
        return "S";
      },
    };

    await ensureAgentSession(deps);
    await ensureAgentSession(deps);
    expect(mints).toBe(1);
  });

  it("force skips the liveness probe and re-mints", async () => {
    let gets = 0;
    let mints = 0;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        return new Response(JSON.stringify({ status: "active" }), { status: 200 });
      }
      gets += 1;
      return new Response(JSON.stringify({ status: "active" }), { status: 200 });
    }) as typeof fetch;

    await ensureAgentSession({
      tcw: fakeTcw("0xFORCE"),
      backendUrl: "https://api.test",
      getToken: () => "tok",
      force: true,
      _mint: async () => {
        mints += 1;
        return "S";
      },
    });

    expect(gets).toBe(0);
    expect(mints).toBe(1);
  });

  it("throws without a token", async () => {
    await expect(
      ensureAgentSession({ tcw: fakeTcw(), backendUrl: "https://api.test", getToken: () => null }),
    ).rejects.toThrow("Not authenticated");
  });

  it("exposes the frozen agent DID", () => {
    expect(AGENT_DID).toBe("did:pkh:eip155:1:0x83cD9777d4128012F878376aCbd6a092DcdDE01c");
  });
});

describe("two-grant session envelope", () => {
  it("scopes the transcript permissions to exactly read-only connector metadata and bodies", () => {
    expect(TRANSCRIPT_PERMISSIONS).toEqual([
      { service: "tinycloud.sql", space: "applications", path: "xyz.tinycloud.tinychat/connectors", actions: ["read"], skipPrefix: true },
      { service: "tinycloud.kv", space: "applications", path: "xyz.tinycloud.tinychat/connectors/", actions: ["get", "list"], skipPrefix: true },
    ]);
    // No write, put, delete, schema, admin, secrets, decrypt, or audio ability.
    const abilities = TRANSCRIPT_PERMISSIONS.flatMap((entry) => entry.actions);
    for (const forbidden of ["write", "put", "delete", "schema", "admin", "secrets", "decrypt"]) {
      expect(abilities).not.toContain(forbidden);
    }
  });

  it("signs the isolated consent session for only memory plus transcript access", () => {
    expect(AGENT_CONSENT_MANIFEST).toMatchObject({
      defaults: false,
      includePublicSpace: false,
      space: "applications",
      prefix: "",
      expiry: "7d",
      permissions: [
        {
          service: "tinycloud.sql",
          space: "default",
          path: "xyz.tinycloud.eliza/memory",
          actions: ["read", "write", "admin"],
          skipPrefix: true,
        },
        ...TRANSCRIPT_PERMISSIONS,
      ],
    });
  });

  it("mints memory and transcripts as separate grants, sequentially, inside seven days", async () => {
    // serializeDelegation is dynamically imported from the DOM-bound web-sdk;
    // supply the one global its custom-element registration touches.
    const shims = globalThis as { HTMLElement?: unknown; customElements?: unknown; window?: unknown };
    shims.HTMLElement ??= class {};
    shims.customElements ??= { define: () => undefined, get: () => undefined };
    const order: string[] = [];
    let inFlight = 0;
    let delegateArgs: { did: string; permissions: unknown; options: { expiry?: number } } | null = null;
    const tcw = {
      address: () => "0xUSER",
      chainId: () => 1,
      hosts: ["https://node.tinycloud.xyz"],
      space: () => ({
        delegations: {
          // Memory mint path (mintAgentDelegation).
          async create() {
            order.push("memory:start");
            inFlight += 1;
            await Promise.resolve();
            inFlight -= 1;
            order.push("memory:end");
            return { ok: true, data: { cid: "memory", delegateDID: AGENT_DID, expiry: new Date() } };
          },
        },
      }),
      async delegateTo(did: string, permissions: unknown, options: { expiry?: number }) {
        order.push("transcripts:start");
        // A concurrent mint would observe the memory derivation still running.
        expect(inFlight).toBe(0);
        delegateArgs = { did, permissions, options };
        order.push("transcripts:end");
        return { delegation: { cid: "transcripts", delegateDID: AGENT_DID, expiry: new Date() } };
      },
    } as unknown as TinyCloudWeb;

    const envelope = await mintAgentSessionDelegations(tcw, { roomId: "thread-1" });

    expect(order).toEqual(["memory:start", "memory:end", "transcripts:start", "transcripts:end"]);
    expect(envelope.version).toBe(2);
    expect(envelope.roomId).toBe("thread-1");
    expect(envelope.delegations.memory).not.toBe(envelope.delegations.transcripts);
    expect(delegateArgs!.did).toBe(AGENT_DID);
    expect(delegateArgs!.permissions).toEqual(TRANSCRIPT_PERMISSIONS);
    expect(delegateArgs!.options.expiry).toBe(AGENT_DELEGATION_EXPIRY_MS);
    expect(AGENT_DELEGATION_EXPIRY_MS).toBeLessThanOrEqual(7 * 24 * 60 * 60 * 1000);
  });

  it("couriers a minted envelope under `session`, and a legacy string under `serialized`", async () => {
    const bodies: unknown[] = [];
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        bodies.push(JSON.parse(init.body as string));
        return new Response(JSON.stringify({ status: "active" }), { status: 200 });
      }
      return new Response(JSON.stringify({ status: "none" }), { status: 404 });
    }) as typeof fetch;

    const envelope = { version: 2 as const, delegations: { memory: "M", transcripts: "T" } };
    await ensureAgentSession({
      tcw: fakeTcw(), backendUrl: "https://api.test", getToken: () => "tok",
      roomId: "thread-9", _mint: async () => envelope,
    });
    clearAgentSessionCache();
    await ensureAgentSession({
      tcw: fakeTcw(), backendUrl: "https://api.test", getToken: () => "tok",
      roomId: "thread-9", _mint: async () => "LEGACY",
    });

    expect(bodies[0]).toEqual({ session: envelope, roomId: "thread-9" });
    expect(bodies[1]).toEqual({ serialized: "LEGACY", roomId: "thread-9" });
  });
});
