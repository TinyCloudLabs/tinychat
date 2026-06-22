// Unit tests for the probeAgentCapability helper extracted from useAgentEnablement.
// Tests the C3 capability-off branch (404→unavailable), 401 treatment,
// network error handling, and the 200+active→enabled / 200+other→available paths.

import { afterEach, describe, expect, it } from "bun:test";
import { probeAgentCapability } from "./useAgentEnablement.js";

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
      new Response(JSON.stringify({ status: "active" }), {
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
