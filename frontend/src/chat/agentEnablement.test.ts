// Unit tests for the probeAgentCapability helper extracted from useAgentEnablement.
// Tests the C3 capability-off branch (404→unavailable), 401 treatment,
// network error handling, and the 200+active→enabled / 200+other→available paths.

import { afterEach, describe, expect, it, vi } from "bun:test";
import { agentAccessStatusLabel, connectErrorMessage, createAgentAccessController, probeAgentCapability, probeAgentSession } from "./useAgentEnablement.js";
import { AgentOwnerMismatchError } from "../lib/agentDelegation.js";

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
      probeFailed: false,
    });
  });

  it("distinguishes a disabled route from an unhealthy backend probe", async () => {
    globalThis.fetch = (async () => new Response(null, { status: 404 })) as typeof fetch;
    expect(await probeAgentSession("https://api.test", "tok")).toMatchObject({
      capability: "unavailable",
      probeFailed: false,
    });

    globalThis.fetch = (async () => new Response(null, { status: 503 })) as typeof fetch;
    expect(await probeAgentSession("https://api.test", "tok")).toMatchObject({
      capability: "unavailable",
      probeFailed: true,
    });

    globalThis.fetch = (async () => { throw new TypeError("Failed to fetch"); }) as typeof fetch;
    expect(await probeAgentSession("https://api.test", "tok")).toMatchObject({
      capability: "unavailable",
      probeFailed: true,
    });
  });

  it("keeps 401 as a reachable route with stale credentials", async () => {
    globalThis.fetch = (async () => new Response(null, { status: 401 })) as typeof fetch;
    expect(await probeAgentSession("https://api.test", "tok")).toMatchObject({
      capability: "available",
      probeFailed: false,
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

function installBrowserEvents() {
  const names = ["window", "document", "BroadcastChannel"];
  const descriptors = names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  const browserWindow = new EventTarget() as EventTarget & { navigator: { onLine: boolean }; setTimeout: Window["setTimeout"] };
  browserWindow.navigator = { onLine: true };
  browserWindow.setTimeout = ((handler: TimerHandler, timeout?: number) =>
    globalThis.setTimeout(handler as () => void, timeout)) as Window["setTimeout"];
  const browserDocument = new EventTarget() as EventTarget & { visibilityState: DocumentVisibilityState };
  browserDocument.visibilityState = "visible";
  Object.defineProperty(globalThis, "window", { configurable: true, value: browserWindow });
  Object.defineProperty(globalThis, "document", { configurable: true, value: browserDocument });
  Object.defineProperty(globalThis, "BroadcastChannel", { configurable: true, value: undefined });
  return {
    window: browserWindow,
    document: browserDocument,
    restore() {
      for (const [name, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    },
  };
}
async function flushMicrotasks() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

describe("agent access connectivity monitoring", () => {
  it("shows Disconnected immediately offline and probes again online", async () => {
    vi.useFakeTimers();
    const browser = installBrowserEvents();
    let probes = 0;
    globalThis.fetch = (async () => { probes++; return Response.json(active); }) as typeof fetch;
    const c = controller();
    const unlisten = c.listen();
    try {
      await c.refresh();
      expect(c.getSnapshot().capability).toBe("enabled");
      browser.window.navigator.onLine = false;
      browser.window.dispatchEvent(new Event("offline"));
      expect(agentAccessStatusLabel(c.getSnapshot())).toBe("Disconnected");
      expect(probes).toBe(1);

      browser.window.navigator.onLine = true;
      browser.window.dispatchEvent(new Event("online"));
      await flushMicrotasks();
      expect(probes).toBe(2);
      expect(c.getSnapshot().capability).toBe("enabled");
    } finally {
      unlisten();
      c.dispose();
      browser.restore();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("re-probes when visible and pauses its timer while hidden", async () => {
    vi.useFakeTimers();
    const browser = installBrowserEvents();
    let probes = 0;
    globalThis.fetch = (async () => { probes++; return Response.json(active); }) as typeof fetch;
    const c = controller();
    const unlisten = c.listen();
    try {
      await c.refresh();
      expect(probes).toBe(1);
      browser.document.visibilityState = "hidden";
      browser.document.dispatchEvent(new Event("visibilitychange"));
      vi.advanceTimersByTime(120_000);
      expect(probes).toBe(1);

      browser.document.visibilityState = "visible";
      browser.document.dispatchEvent(new Event("visibilitychange"));
      await flushMicrotasks();
      expect(probes).toBe(2);
      vi.advanceTimersByTime(60_000);
      expect(probes).toBe(3);
    } finally {
      unlisten();
      c.dispose();
      browser.restore();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("recovers from Agent unavailable on a backed-off visible probe", async () => {
    vi.useFakeTimers();
    const browser = installBrowserEvents();
    let probes = 0;
    globalThis.fetch = (async () => {
      probes++;
      return probes === 1 ? new Response(null, { status: 503 }) : Response.json(active);
    }) as typeof fetch;
    const c = controller();
    const unlisten = c.listen();
    try {
      await c.refresh();
      expect(agentAccessStatusLabel(c.getSnapshot())).toBe("Agent unavailable");
      vi.advanceTimersByTime(119_999);
      expect(probes).toBe(1);
      vi.advanceTimersByTime(1);
      await flushMicrotasks();
      expect(probes).toBe(2);
      expect(c.getSnapshot().capability).toBe("enabled");
      expect(agentAccessStatusLabel(c.getSnapshot())).toBe("Connected");
    } finally {
      unlisten();
      c.dispose();
      browser.restore();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("backs off consecutive failed probes and resets to one minute after recovery", async () => {
    vi.useFakeTimers();
    const browser = installBrowserEvents();
    let probes = 0;
    globalThis.fetch = (async () => {
      probes++;
      return probes < 3 ? new Response(null, { status: 503 }) : Response.json(active);
    }) as typeof fetch;
    const c = controller();
    const unlisten = c.listen();
    try {
      await c.refresh();
      vi.advanceTimersByTime(119_999);
      expect(probes).toBe(1);
      vi.advanceTimersByTime(1);
      await flushMicrotasks();
      expect(probes).toBe(2);

      vi.advanceTimersByTime(239_999);
      expect(probes).toBe(2);
      vi.advanceTimersByTime(1);
      await flushMicrotasks();
      expect(probes).toBe(3);
      expect(c.getSnapshot().capability).toBe("enabled");

      vi.advanceTimersByTime(59_999);
      expect(probes).toBe(3);
      vi.advanceTimersByTime(1);
      await flushMicrotasks();
      expect(probes).toBe(4);
    } finally {
      unlisten();
      c.dispose();
      browser.restore();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
});
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
  it("broadcasts access invalidation before replacement and disconnect requests", async () => {
    vi.useFakeTimers();
    const names = ["window", "document", "BroadcastChannel"];
    const descriptors = names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
    const messages: unknown[] = [];
    class TestBroadcastChannel {
      onmessage: ((event: MessageEvent) => void) | null = null;
      constructor(readonly name: string) {}
      postMessage(message: unknown) { messages.push(message); }
      close() {}
    }
    Object.defineProperty(globalThis, "window", { configurable: true, value: {
      navigator: { onLine: true }, setTimeout: globalThis.setTimeout,
      addEventListener() {}, removeEventListener() {},
    } });
    Object.defineProperty(globalThis, "document", { configurable: true, value: {
      addEventListener() {}, removeEventListener() {}, visibilityState: "visible",
    } });
    Object.defineProperty(globalThis, "BroadcastChannel", { configurable: true, value: TestBroadcastChannel });

    const post = deferred<Response>(); const posted = deferred<void>();
    const deletion = deferred<Response>(); const deleted = deferred<void>();
    globalThis.fetch = (async (_url, init) => {
      if (init?.method === "POST") { posted.resolve(); return post.promise; }
      if (init?.method === "DELETE") { deleted.resolve(); return deletion.promise; }
      return Response.json(active);
    }) as typeof fetch;
    const c = controller();
    const unlisten = c.listen();
    try {
      await c.refresh();
      const enabling = c.onEnable();
      await posted.promise;
      expect(messages).toEqual(["changed"]);
      post.resolve(Response.json(active));
      await enabling;
      expect(messages).toEqual(["changed", "changed"]);

      const disconnecting = c.onDisconnect();
      await deleted.promise;
      expect(messages).toEqual(["changed", "changed", "changed"]);
      deletion.resolve(Response.json({ status: "none", revision: "r2" }));
      await disconnecting;
      expect(messages).toEqual(["changed", "changed", "changed", "changed"]);
    } finally {
      unlisten();
      c.dispose();
      for (const [name, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
      vi.clearAllTimers();
      vi.useRealTimers();
    }
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

describe("turn admission reports", () => {
  it("flips a connected browser to reconnect when a turn had no private access", async () => {
    globalThis.fetch = (async () => Response.json(active)) as typeof fetch;
    const c = controller(); await c.refresh();
    expect(c.getSnapshot().capability).toBe("enabled");
    c.onDelegationError("delegation_required");
    expect(c.getSnapshot()).toMatchObject({ capability: "available", status: "stale", reconnectReason: "delegation_required" });
    expect(c.privateAccessRef.current.active).toBe(false);
    c.dispose();
  });

  it("reports a failed check as unknown, not as an expired or missing grant", async () => {
    globalThis.fetch = (async () => Response.json(active)) as typeof fetch;
    const c = controller(); await c.refresh();
    c.onDelegationError("delegation_unverified");
    expect(c.getSnapshot()).toMatchObject({ capability: "available", status: null, reconnectReason: "delegation_unverified" });
    expect(c.privateAccessRef.current.active).toBe(false);
    // A later healthy probe clears the prompt.
    await c.refresh();
    expect(c.getSnapshot()).toMatchObject({ capability: "enabled", reconnectReason: null });
    c.dispose();
  });

  it("keeps Connect copy when the browser already knows access is off", async () => {
    globalThis.fetch = (async () => Response.json({ status: "none", revision: "r0" })) as typeof fetch;
    const c = controller(); await c.refresh();
    const before = c.privateAccessRef.current;
    c.onDelegationError("delegation_required");
    c.onDelegationError("delegation_unverified");
    expect(c.getSnapshot()).toMatchObject({ capability: "available", status: "none", reconnectReason: null });
    expect(c.privateAccessRef.current).toBe(before);
    c.onDelegationError("delegation_expired");
    expect(c.getSnapshot()).toMatchObject({ status: "expired", reconnectReason: "delegation_expired" });
    c.dispose();
  });
  it("names the server's rejection code instead of a generic Connect failure", async () => {
    for (const [code, copy] of [
      ["delegation_expiry_too_long", "device clock"],
      ["transcript_policy_exceeded", "Failed to connect private agent access (transcript_policy_exceeded)"],
    ] as const) {
      globalThis.fetch = (async (_url, init) => init?.method === "POST"
        ? Response.json({ error: code, message: "free text the UI must not echo" }, { status: 400 })
        : Response.json({ status: "none", revision: "r0" })) as typeof fetch;
      const c = controller(); await c.refresh();
      await c.onEnable();
      expect(c.getSnapshot().enableError).toContain(code);
      expect(c.getSnapshot().enableError).toContain(copy);
      expect(c.getSnapshot().enableError).not.toContain("free text");
      c.dispose();
    }
  });
});

describe("agent access status labels", () => {
  const state = { status: null, reconnectReason: null, disconnecting: false, probeFailed: false };

  it("maps each shared controller state to a visible label", () => {
    expect(agentAccessStatusLabel({ ...state, capability: "enabled", status: "active" })).toBe("Connected");
    expect(agentAccessStatusLabel({ ...state, capability: "available", status: "none" })).toBe("Disconnected");
    expect(agentAccessStatusLabel({ ...state, capability: "available", reconnectReason: "delegation_unverified" }))
      .toBe("Access could not be verified");
    expect(agentAccessStatusLabel({ ...state, capability: "unavailable", probeFailed: false })).toBe("Disconnected");
    expect(agentAccessStatusLabel({ ...state, capability: "unavailable", probeFailed: true })).toBe("Agent unavailable");
    expect(agentAccessStatusLabel({ ...state, capability: "probing" })).toBe("Checking…");
  });
});
describe("connectErrorMessage", () => {
  it("shows the wrong-key message as is", () => {
    const message = "You picked a different OpenKey key (0xbbbb…bbbb) than the one you're signed in with (0xaaaa…aaaa). To connect the agent, choose 0xaaaa…aaaa in OpenKey.";
    expect(connectErrorMessage(new AgentOwnerMismatchError(message))).toBe(message);
  });
});
