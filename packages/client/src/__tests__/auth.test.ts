import { afterEach, describe, expect, test } from "bun:test";
import { verifySession } from "../auth.js";

describe("verifySession", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("uses the neutral CSRF request header default", async () => {
    let capturedInit: RequestInit | undefined;

    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      capturedInit = init;
      return new Response(
        JSON.stringify({
          token: "session-token",
          expiresIn: 3600,
          address: "0xabc",
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }) as typeof fetch;

    await verifySession("https://api.example.com", "siwe", "signature");

    expect((capturedInit?.headers as Record<string, string>)["X-Requested-With"]).toBe(
      "XMLHttpRequest",
    );
  });
});
