import { afterEach, describe, expect, test } from "bun:test";

const realFetch = globalThis.fetch;

describe("vendored GPU relay error handling", () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("returns a visible non-passing GPU result when the NRAS relay returns an error body", async () => {
    (globalThis as { HTMLElement?: unknown }).HTMLElement ??= class HTMLElement {};
    const { checkGpu } = await import("./vendor/redpill-verifier/verifiers/cloud-api");

    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: "upstream_error", message: "Failed to reach NRAS" }), {
        status: 502,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;

    const result = await checkGpu({ nonce: "abc123" }, "abc123");

    expect(result).toEqual({
      nonceMatches: true,
      verdict: "nras_relay_error",
      signatureVerified: false,
    });
  });
});
