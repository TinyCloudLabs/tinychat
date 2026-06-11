import { afterEach, describe, expect, test } from "bun:test";
import type { SessionStore } from "@tinyboilerplate/client";
import {
  createBackendAttestationNonce,
  fetchBackendSelfAttestation,
} from "./backendAttestation";

const originalFetch = globalThis.fetch;

function sessionStore(): SessionStore {
  return {
    getToken: () => "test-token",
    isExpired: () => false,
    clear: () => {},
  } as SessionStore;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("backend attestation client", () => {
  test("creates a lowercase 32-byte hex nonce", () => {
    expect(createBackendAttestationNonce()).toMatch(/^[0-9a-f]{64}$/);
  });

  test("fetches self-attestation with session auth headers", async () => {
    let capturedUrl = "";
    let capturedHeaders: HeadersInit | undefined;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = input.toString();
      capturedHeaders = init?.headers;
      return new Response(
        JSON.stringify({
          quote: "0xquote",
          event_log: "[]",
          report_data: "b".repeat(64),
          identity: {
            did: "did:pkh:eip155:1:0x0000000000000000000000000000000000000001",
            address: "0x0000000000000000000000000000000000000001",
            nonce: "a".repeat(64),
            nonce_signature: "0xsig",
          },
          info: { app_id: "app_123" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const result = await fetchBackendSelfAttestation({
      backendUrl: "https://api.example.test",
      sessionStore: sessionStore(),
      nonce: "a".repeat(64),
    });

    expect(result.status).toBe("available");
    expect(result.attestation?.quote).toBe("0xquote");
    expect(capturedUrl).toBe(
      `https://api.example.test/api/attestation/self?nonce=${"a".repeat(64)}`,
    );
    expect((capturedHeaders as Record<string, string>).Authorization).toBe("Bearer test-token");
    expect((capturedHeaders as Record<string, string>)["X-Requested-With"]).toBe(
      "XMLHttpRequest",
    );
  });

  test("returns unavailable for local environments without dstack", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          error: "attestation_unavailable",
          message: "dstack socket is not available",
        }),
        { status: 503, headers: { "content-type": "application/json" } },
      )) as typeof fetch;

    const result = await fetchBackendSelfAttestation({
      backendUrl: "https://api.example.test",
      sessionStore: sessionStore(),
      nonce: "a".repeat(64),
    });

    expect(result).toEqual({
      status: "unavailable",
      message: "dstack socket is not available",
    });
  });
});
