import { afterEach, describe, expect, it } from "bun:test";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import {
  actionsFromAuthJwt,
  AGENT_DID,
  clearAgentSessionCache,
  ensureAgentSession,
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
