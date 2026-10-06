import { afterEach, describe, expect, it } from "bun:test";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { SESSION_EXPIRATION_MS } from "@tinyboilerplate/core";
import {
  actionsFromAuthJwt,
  AGENT_CONSENT_MANIFEST,
  AGENT_DID,
  AGENT_DELEGATION_EXPIRY_MS,
  AgentOwnerMismatchError,
  AgentSessionError,
  assertAgentOwner,
  clearAgentSessionCache,
  ensureAgentSession,
  mintAgentSessionDelegations,
  mintAgentSessionViaFreshSignIn,
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
      return new Response(JSON.stringify({ status: "active", transcriptStatus: "active", revision: "instance:1" }), { status: 200 });
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
        return new Response(JSON.stringify({ entityId: "e", status: "active", transcriptStatus: "active", revision: "instance:1" }), { status: 200 });
      }
      return new Response(JSON.stringify({ status: "none", revision: "instance:0" }), { status: 200 });
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
    expect(post?.body).toEqual({ serialized: "SERIALIZED_DELEGATION", roomId: "thread-9", revision: "instance:0" });
  });

  it("re-probes an active session without minting again", async () => {
    let mints = 0;
    globalThis.fetch = (async (_url: string, init?: RequestInit) =>
      init?.method === "POST"
        ? new Response(JSON.stringify({ status: "active", transcriptStatus: "active", revision: "instance:1" }), { status: 200 })
        : new Response(JSON.stringify(mints ? { status: "active", transcriptStatus: "active", revision: "instance:1" } : { status: "none", revision: "instance:0" }), { status: 200 })) as typeof fetch;

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

  it("force fetches a revision before re-minting", async () => {
    let gets = 0;
    let mints = 0;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        return new Response(JSON.stringify({ status: "active", transcriptStatus: "active", revision: "instance:1" }), { status: 200 });
      }
      gets += 1;
      return new Response(JSON.stringify({ status: "active", transcriptStatus: "active", revision: "instance:1" }), { status: 200 });
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

    expect(gets).toBe(1);
    expect(mints).toBe(1);
  });

  it("force re-mints even after an earlier active status", async () => {
    let gets = 0;
    let mints = 0;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        return new Response(JSON.stringify({ status: "active", transcriptStatus: "active", revision: "instance:1" }), { status: 200 });
      }
      gets += 1;
      return new Response(JSON.stringify({ status: "active", transcriptStatus: "active", revision: "instance:1" }), { status: 200 });
    }) as typeof fetch;

    const tcw = fakeTcw("0xSTALE_CACHE");
    await ensureAgentSession({
      tcw,
      backendUrl: "https://api.test",
      getToken: () => "tok",
      _mint: async () => "unused",
    });
    await ensureAgentSession({
      tcw,
      backendUrl: "https://api.test",
      getToken: () => "tok",
      force: true,
      _mint: async () => {
        mints += 1;
        return "renewed";
      },
    });

    expect(gets).toBe(2);
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

  it("consents to memory schema creation while keeping transcripts read-only", () => {
    expect(AGENT_CONSENT_MANIFEST).toMatchObject({
      defaults: false,
      includePublicSpace: false,
      space: "applications",
      prefix: "",
      expiry: "30d",
      permissions: [
        {
          service: "tinycloud.sql",
          space: "default",
          path: "xyz.tinycloud.eliza/memory",
          actions: ["read", "write", "admin", "schema"],
          skipPrefix: true,
        },
        ...TRANSCRIPT_PERMISSIONS,
      ],
    });
  });

  it("mints memory and transcripts as separate grants, sequentially, for 29 days", async () => {
    // serializeDelegation is dynamically imported from the DOM-bound web-sdk;
    // supply the one global its custom-element registration touches.
    const shims = globalThis as { HTMLElement?: unknown; customElements?: unknown; window?: unknown };
    shims.HTMLElement ??= class {};
    shims.customElements ??= { define: () => undefined, get: () => undefined };
    const order: string[] = [];
    let inFlight = 0;
    let memoryArgs: unknown;
    let memorySpace: string | undefined;
    let delegateArgs: { did: string; permissions: unknown; options: { expiry?: number } } | null = null;
    const tcw = {
      address: () => "0xUSER",
      chainId: () => 1,
      hosts: ["https://node.tinycloud.xyz"],
      space: (name: string) => {
        memorySpace = name;
        return {
          delegations: {
            // Memory mint path (mintAgentDelegation).
            async create(args: unknown) {
              memoryArgs = args;
              order.push("memory:start");
              inFlight += 1;
              await Promise.resolve();
              inFlight -= 1;
              order.push("memory:end");
              return { ok: true, data: { cid: "memory", delegateDID: AGENT_DID, expiry: new Date() } };
            },
          },
        };
      },
      async delegateTo(did: string, permissions: unknown, options: { expiry?: number }) {
        order.push("transcripts:start");
        // A concurrent mint would observe the memory derivation still running.
        expect(inFlight).toBe(0);
        delegateArgs = { did, permissions, options };
        order.push("transcripts:end");
        return { delegation: { cid: "transcripts", delegateDID: AGENT_DID, expiry: new Date() } };
      },
    } as unknown as TinyCloudWeb;

    const mintedAt = Date.now();
    const envelope = await mintAgentSessionDelegations(tcw, { roomId: "thread-1" });

    expect(order).toEqual(["memory:start", "memory:end", "transcripts:start", "transcripts:end"]);
    expect(envelope.version).toBe(2);
    expect(envelope.roomId).toBe("thread-1");
    expect(envelope.delegations.memory).not.toBe(envelope.delegations.transcripts);
    expect(memorySpace).toBe("default");
    expect(memoryArgs).toEqual({
      delegateDID: AGENT_DID,
      path: "xyz.tinycloud.eliza/memory",
      actions: ["tinycloud.sql/read", "tinycloud.sql/write", "tinycloud.sql/admin", "tinycloud.sql/schema", "tinycloud.capabilities/read"],
      expiry: expect.any(Date),
    });
    expect(delegateArgs!.did).toBe(AGENT_DID);
    expect(delegateArgs!.permissions).toEqual(TRANSCRIPT_PERMISSIONS);
    expect(delegateArgs!.options.expiry).toBe(AGENT_DELEGATION_EXPIRY_MS);
    const memoryExpiry = (memoryArgs as { expiry: Date }).expiry.getTime();
    expect(memoryExpiry - mintedAt).toBeGreaterThanOrEqual(AGENT_DELEGATION_EXPIRY_MS);
    expect(memoryExpiry - mintedAt).toBeLessThan(AGENT_DELEGATION_EXPIRY_MS + 60_000);
  });

  it("mints a day inside the 30-day ceiling and the parent consent session", () => {
    const day = 24 * 60 * 60 * 1000;
    expect(AGENT_DELEGATION_EXPIRY_MS).toBe(29 * day);
    // Backend courier and eliza-service reject grants longer than this on their clock.
    expect(SESSION_EXPIRATION_MS).toBe(30 * day);
    expect(SESSION_EXPIRATION_MS - AGENT_DELEGATION_EXPIRY_MS).toBe(day);
    expect(AGENT_CONSENT_MANIFEST.expiry).toBe("30d");
  });

  it("reports the server's error code when the courier rejects a grant", async () => {
    globalThis.fetch = (async (_url: string, init?: RequestInit) => init?.method === "POST"
      ? new Response(JSON.stringify({ error: "delegation_expiry_too_long" }), { status: 400 })
      : new Response(JSON.stringify({ status: "none", revision: "instance:0" }), { status: 200 })) as typeof fetch;
    const error = await ensureAgentSession({
      tcw: fakeTcw(), backendUrl: "https://api.test", getToken: () => "tok",
      _mint: async () => ({ version: 2, delegations: { memory: "m", transcripts: "t" } }),
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AgentSessionError);
    expect(error).toMatchObject({ status: 400, code: "delegation_expiry_too_long" });
  });

  it("couriers a minted envelope under `session`, and a legacy string under `serialized`", async () => {
    const bodies: unknown[] = [];
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        bodies.push(JSON.parse(init.body as string));
        return new Response(JSON.stringify({ status: "active", transcriptStatus: "active", revision: "instance:1" }), { status: 200 });
      }
      return new Response(JSON.stringify({ status: "none", revision: "instance:0" }), { status: 200 });
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

    expect(bodies[0]).toEqual({ session: envelope, roomId: "thread-9", revision: "instance:0" });
    expect(bodies[1]).toEqual({ serialized: "LEGACY", roomId: "thread-9", revision: "instance:0" });
  });
});


describe("access replacement contract", () => {
  it("captures the revision before minting and posts it without rebasing", async () => {
    const order: string[] = [];
    let posted: any;
    globalThis.fetch = (async (_url, init) => {
      order.push(init?.method ?? "GET");
      if (init?.method === "POST") {
        posted = JSON.parse(String(init.body));
        return Response.json({ status: "active", transcriptStatus: "active", revision: "new" });
      }
      return Response.json({ status: "active", transcriptStatus: "active", revision: "before-mint" });
    }) as typeof fetch;
    await ensureAgentSession({ tcw: fakeTcw(), backendUrl: "https://api.test", getToken: () => "token", force: true,
      _mint: async () => { order.push("mint"); return "grant"; } });
    expect(order).toEqual(["GET", "mint", "POST"]);
    expect(posted.revision).toBe("before-mint");
  });

  it.each([{}, { status: "active" }, { status: "active", transcriptStatus: "none" }])("rejects a partial or absent activation status %j", async (result) => {
    globalThis.fetch = (async (_url, init) => Response.json(init?.method === "POST" ? result : { status: "none", revision: "r" })) as typeof fetch;
    await expect(ensureAgentSession({ tcw: fakeTcw(), backendUrl: "https://api.test", getToken: () => "token", force: true, _mint: async () => "grant" })).rejects.toThrow();
  });

  it("does not start a ceremony without an authoritative revision", async () => {
    let mints = 0;
    globalThis.fetch = (async () => Response.json({ status: "none" })) as typeof fetch;
    await expect(ensureAgentSession({ tcw: fakeTcw(), backendUrl: "https://api.test", getToken: () => "token", force: true, _mint: async () => { mints++; return "grant"; } })).rejects.toThrow();
    expect(mints).toBe(0);
  });
});

describe("Connect agent owner check (TC-706)", () => {
  const SESSION = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
  const OTHER = "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359";
  const MISMATCH = "You picked a different OpenKey key (0xfB69…d359) than the one you're signed in with (0x5aAe…eAed). "
    + "To connect the agent, choose 0x5aAe…eAed in OpenKey.";
  const provider = { on() {}, removeListener() {}, request: async () => { throw new Error("no signing in tests"); } };
  const fresh = (connected: string, sessionAddress: string | undefined = SESSION) => () => mintAgentSessionViaFreshSignIn({
    appName: "test", openkeyHost: "https://openkey.test", sessionAddress,
    _connect: async () => ({ address: connected, web3Provider: provider }),
  });

  it("accepts the signed-in key whatever its checksum casing", () => {
    expect(() => assertAgentOwner(SESSION, SESSION)).not.toThrow();
    expect(() => assertAgentOwner(SESSION, SESSION.toLowerCase())).not.toThrow();
    expect(() => assertAgentOwner(SESSION.toLowerCase(), SESSION.toUpperCase().replace("0X", "0x"))).not.toThrow();
  });

  it("lets a matching key with different casing past the check into sign-in", async () => {
    const error = await fresh(SESSION.toLowerCase())().catch((caught: unknown) => caught);
    // Sign-in itself cannot run under bun test; it only matters that the owner check passed.
    expect(error).not.toBeInstanceOf(AgentOwnerMismatchError);
  });

  it("refuses a different key with both addresses named", () => {
    expect(() => assertAgentOwner(SESSION, OTHER)).toThrow(new AgentOwnerMismatchError(MISMATCH));
  });

  it("refuses when the session address is unknown", () => {
    expect(() => assertAgentOwner(undefined, OTHER)).toThrow(AgentOwnerMismatchError);
    expect(() => assertAgentOwner("", OTHER)).toThrow(AgentOwnerMismatchError);
  });

  it("refuses a different key before any delegation is minted or sent", async () => {
    const methods: string[] = [];
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      methods.push(init?.method ?? "GET");
      return Response.json({ status: "none", revision: "instance:0" });
    }) as typeof fetch;
    const error = await ensureAgentSession({
      tcw: fakeTcw(SESSION), backendUrl: "https://api.test", getToken: () => "tok", force: true,
      _mint: fresh(OTHER),
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AgentOwnerMismatchError);
    expect((error as Error).message).toBe(MISMATCH);
    expect(methods).toEqual(["GET"]);
  });
});

describe("Connect agent passkey support", () => {
  const SESSION = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
  const provider = { on() {}, removeListener() {}, request: async () => { throw new Error("no signing in tests"); } };
  const realWindow = (globalThis as { window?: unknown }).window;
  afterEach(() => { (globalThis as { window?: unknown }).window = realWindow; });

  async function passkeysSupportedSentToOpenKey(): Promise<boolean | undefined> {
    let sent: boolean | undefined;
    await mintAgentSessionViaFreshSignIn({
      appName: "test", openkeyHost: "https://openkey.test", sessionAddress: SESSION,
      _connect: async (config) => { sent = config.passkeysSupported; return { address: SESSION, web3Provider: provider }; },
    }).catch(() => undefined); // Sign-in itself cannot run under bun test.
    return sent;
  }

  it("keeps passkeys on the web", async () => {
    (globalThis as { window?: unknown }).window = {};
    expect(await passkeysSupportedSentToOpenKey()).toBe(true);
  });

  it("turns passkeys off in the Tauri desktop shell", async () => {
    (globalThis as { window?: unknown }).window = { __TAURI_INTERNALS__: {} };
    expect(await passkeysSupportedSentToOpenKey()).toBe(false);
  });
});
