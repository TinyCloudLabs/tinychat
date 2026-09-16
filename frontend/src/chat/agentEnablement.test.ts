// Unit tests for the probeAgentCapability helper extracted from useAgentEnablement.
// Tests the C3 capability-off branch (404→unavailable), 401 treatment,
// network error handling, and the 200+active→enabled / 200+other→available paths.

import { afterEach, describe, expect, it } from "bun:test";
import { createAgentAccessController, probeAgentCapability, probeAgentSession } from "./useAgentEnablement.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("probeAgentCapability", () => {
  it("returns 'unavailable' on 404 (route absent)", async () => {
    globalThis.fetch = (async () => new Response(null, { status: 404 })) as typeof fetch;
    expect(await probeAgentCapability("https://api.test", "tok")).toBe("unavailable");
  });

  it("returns 'unavailable' on other non-2xx non-401 status", async () => {
    globalThis.fetch = (async () => new Response(null, { status: 503 })) as typeof fetch;
    expect(await probeAgentCapability("https://api.test", "tok")).toBe("unavailable");
  });

  it("returns 'available' on 401 (route exists, token stale)", async () => {
    globalThis.fetch = (async () => new Response(null, { status: 401 })) as typeof fetch;
    expect(await probeAgentCapability("https://api.test", "tok")).toBe("available");
  });

  it("returns 'unavailable' on network error", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("Failed to fetch");
    }) as typeof fetch;
    expect(await probeAgentCapability("https://api.test", "tok")).toBe("unavailable");
  });

  it("returns 'enabled' on 200 with status='active'", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ status: "active", transcriptStatus: "active", revision: "r1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
    expect(await probeAgentCapability("https://api.test", "tok")).toBe("enabled");
  });

  it("returns 'available' on 200 with non-active status", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ status: "none" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
    expect(await probeAgentCapability("https://api.test", "tok")).toBe("available");
  });

  it("preserves an expired status so the UI can offer Reconnect", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ status: "expired" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;

    expect(await probeAgentSession("https://api.test", "tok")).toEqual({
      capability: "available",
      status: "expired",
      revision: null,
    });
  });

  it("strips trailing slash from backendUrl before calling /api/agent/session", async () => {
    let calledUrl = "";
    globalThis.fetch = (async (url: RequestInfo | URL) => {
      calledUrl = String(url);
      return new Response(JSON.stringify({ status: "none" }), { status: 200 });
    }) as typeof fetch;
    await probeAgentCapability("https://api.test/", "tok");
    expect(calledUrl).toBe("https://api.test/api/agent/session");
  });
});


function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function controller(mint: () => Promise<any> = async () => ({ version: 2, delegations: { memory: "m", transcripts: "t" } })) {
  return createAgentAccessController({
    backendUrl: "https://api.test", tcw: { address: () => "0xone" } as never,
    sessionStore: { getToken: () => "token" } as never,
    appName: "test", openkeyHost: "https://openkey.test", _mint: mint,
  });
}
const active = { status: "active", transcriptStatus: "active", revision: "r1" };

describe("shared private access controller", () => {
  it("coalesces immediate repeated clicks into one ceremony", async () => {
    const mint = deferred<any>(); let count = 0;
    globalThis.fetch = (async () => Response.json(active)) as typeof fetch;
    const c = controller(() => { count++; return mint.promise; });
    const first = c.onEnable(); const second = c.onEnable();
    expect(first).toBe(second);
    await Promise.resolve(); await Promise.resolve();
    mint.resolve({ version: 2, delegations: { memory: "m", transcripts: "t" } });
    await first;
    expect(count).toBe(1);
    expect(c.getSnapshot().capability).toBe("enabled");
    c.dispose();
  });

  it("disconnect invalidates a pending ceremony before its POST and keeps public routing", async () => {
    const mint = deferred<any>(); const started = deferred<void>(); let posts = 0;
    globalThis.fetch = (async (_url, init) => {
      if (init?.method === "POST") posts++;
      return Response.json(init?.method === "DELETE" ? { status: "none", revision: "r2" } : active);
    }) as typeof fetch;
    const c = controller(() => { started.resolve(); return mint.promise; });
    await c.refresh();
    const connecting = c.onEnable(); await started.promise;
    const stopping = c.onDisconnect();
    expect(c.privateAccessRef.current.active).toBe(false);
    expect(c.agentEnabledRef.current).toBe(true);
    await stopping;
    mint.resolve({ version: 2, delegations: { memory: "m", transcripts: "t" } });
    await connecting;
    expect(posts).toBe(0);
    expect(c.getSnapshot().capability).toBe("available");
    c.dispose();
  });

  it("gates browser private context while server replacement is pending", async () => {
    const post = deferred<Response>(); const posted = deferred<void>();
    globalThis.fetch = (async (_url, init) => {
      if (init?.method === "POST") { posted.resolve(); return post.promise; }
      return Response.json(active);
    }) as typeof fetch;
    const c = controller(); await c.refresh();
    const replacing = c.onEnable(); await posted.promise;
    expect(c.privateAccessRef.current.active).toBe(false);
    expect(c.getSnapshot().status).toBe(null);
    post.resolve(Response.json(active)); await replacing;
    expect(c.privateAccessRef.current.active).toBe(true);
    c.dispose();
  });

  it("rejects an old status response after disconnect", async () => {
    const old = deferred<Response>();
    globalThis.fetch = (async (_url, init) => init?.method === "DELETE"
      ? Response.json({ status: "none", revision: "r2" }) : old.promise) as typeof fetch;
    const c = controller();
    const pending = c.refresh(); await c.onDisconnect();
    old.resolve(Response.json(active)); await pending;
    expect(c.privateAccessRef.current.active).toBe(false);
    expect(c.getSnapshot().capability).toBe("available");
    c.dispose();
  });

  it("does not let a focus probe during DELETE restore old active access", async () => {
    const stop = deferred<Response>(); let gets = 0;
    globalThis.fetch = (async (_url, init) => {
      if (init?.method === "DELETE") return stop.promise;
      gets++; return Response.json(active);
    }) as typeof fetch;
    const c = controller(); await c.refresh();
    const stopping = c.onDisconnect();
    await c.refresh();
    expect(gets).toBe(1);
    stop.resolve(Response.json({ status: "none", revision: "stopped" })); await stopping;
    expect(c.privateAccessRef.current.active).toBe(false);
    expect(c.getSnapshot().revision).toBe("stopped");
    c.dispose();
  });

  it("reports unknown when service does not confirm disconnect", async () => {
    globalThis.fetch = (async () => new Response(null, { status: 503 })) as typeof fetch;
    const c = controller(); await c.onDisconnect();
    expect(c.getSnapshot().status).toBe(null);
    expect(c.getSnapshot().enableError).toContain("not confirmed");
    expect(c.privateAccessRef.current.active).toBe(false);
    c.dispose();
  });

  it("cancelled reconnect refreshes the old connected state and reports failure", async () => {
    globalThis.fetch = (async () => Response.json(active)) as typeof fetch;
    const c = controller(async () => { throw new DOMException("cancel", "NotAllowedError"); });
    await c.onEnable();
    expect(c.getSnapshot().capability).toBe("enabled");
    expect(c.getSnapshot().enableError).toContain("cancelled");
    c.dispose();
  });
});
