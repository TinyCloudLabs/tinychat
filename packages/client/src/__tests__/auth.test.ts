import { afterEach, describe, expect, test } from "bun:test";
import { requestNonce, verifySession } from "../auth.js";

describe("requestNonce", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("an empty address remains an address-bound request", async () => {
    let url = "";
    globalThis.fetch = (async (input: string | URL | Request) => {
      url = String(input);
      return new Response(JSON.stringify({ error: "invalid_address", message: "A valid address is required" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    await expect(requestNonce("https://api.example.com", "")).rejects.toThrow(/valid address/i);
    expect(url).toBe("https://api.example.com/api/auth/nonce?address=");
  });
});

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
