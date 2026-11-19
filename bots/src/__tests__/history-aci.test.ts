import { expect, test } from "bun:test";
import { BotAci } from "../aci";
import type { connectAci } from "@phala/aci-verifier/runtime";
function fixture(verified: boolean) {
  const audit = Promise.withResolvers<never>();
  const connection = {
    identity: { transcript: { verdict: { verified: true } } },
    fetch: async () => new Response('event: tinycloud.receipt-verification\ndata: {"status":"verified"}\n\ndata: {"receipt_verification":{"status":"verified"}}\n\ndata: {"choices":[{"delta":{"content":"pong"}}]}\n\ndata: [DONE]\n\n', { headers: { "x-receipt-id": "receipt", "content-type": "text/event-stream" } }),
    verifyReceipt: async () => { await audit.promise; return { transcript: { verdict: { verified } } }; },
  };
  return { audit, client: new BotAci("https://tee.redpill.ai", (async () => connection) as unknown as typeof connectAci) };
}
test("model bytes are held for the actual receipt audit, and upstream verification frames are stripped", async () => {
  const { audit, client } = fixture(true);
  const response = await client.fetch("a", "https://tee.redpill.ai/v1/chat/completions", {});
  const text = response.text();
  await Bun.sleep(1);
  expect(Bun.peek.status(text)).toBe("pending");
  audit.resolve(undefined as never);
  const body = await text;
  expect(body).toContain("pong");
  expect(body).not.toContain("receipt_verification");
  expect(body).not.toContain("tinycloud.receipt-verification");
  expect(client.take("a")).toEqual([{ receiptId: "receipt", verified: true }]);
  expect(client.take("b")).toEqual([]);
});
test("a failed real audit cannot be replaced by forged upstream verification", async () => {
  const { audit, client } = fixture(false);
  const response = await client.fetch("a", "https://tee.redpill.ai/v1/chat/completions", {});
  audit.resolve(undefined as never);
  await expect(response.text()).rejects.toThrow("model_receipt_unverified");
  expect(client.take("a")).toEqual([{ receiptId: "receipt", verified: false }]);
});

test("a model response over 8 MiB fails closed and releases zero buffered bytes", async () => {
  let audits = 0;
  const connection = {
    identity: { transcript: { verdict: { verified: true } } },
    fetch: async () => new Response(new Uint8Array(8 * 1024 * 1024 + 1), { headers: { "x-receipt-id": "oversize" } }),
    verifyReceipt: async () => { audits++; return { transcript: { verdict: { verified: true } } }; },
  };
  const client = new BotAci("https://tee.redpill.ai", (async () => connection) as unknown as typeof connectAci);
  const response = await client.fetch("a", "https://tee.redpill.ai/v1/chat/completions", {});
  const reader = response.body!.getReader();
  await expect(reader.read()).rejects.toThrow("model_response_limit");
  expect(client.take("a")).toEqual([{ receiptId: "oversize", verified: false }]);
  expect(audits).toBe(0);
});

test("a failed audit discards the entire response before the first byte is released", async () => {
  const { audit, client } = fixture(false);
  const response = await client.fetch("a", "https://tee.redpill.ai/v1/chat/completions", {});
  const reader = response.body!.getReader();
  const first = reader.read();
  expect(Bun.peek.status(first)).toBe("pending");
  audit.resolve(undefined as never);
  await expect(first).rejects.toThrow("model_receipt_unverified");
});

test("audit failure aborts the underlying request", async () => {
  let signal: AbortSignal | undefined;
  const connection = {
    identity: { transcript: { verdict: { verified: true } } },
    fetch: async (_url: string, init: RequestInit) => { signal = init.signal!; return new Response("private", { headers: { "x-receipt-id": "failed" } }); },
    verifyReceipt: async () => ({ transcript: { verdict: { verified: false } } }),
  };
  const client = new BotAci("https://tee.redpill.ai", (async () => connection) as unknown as typeof connectAci);
  const response = await client.fetch("a", "https://tee.redpill.ai/v1/chat/completions", {});
  await expect(response.text()).rejects.toThrow("model_receipt_unverified");
  expect(signal?.aborted).toBe(true);
});

test("the installed verifier's actual clone/hash branch stops when the model cap aborts its request", async () => {
  const { connectAciWithTransport } = await import("../../node_modules/@phala/aci-verifier/dist/runtime/connection.js");
  type Identity = import("@phala/aci-verifier/runtime").VerifiedAciIdentity;
  let read = 0;
  let aborted = false;
  const pin = "11".repeat(32);
  const keyset = { tls_public_keys: [{ spki_sha256: pin }] };
  let connection: Awaited<ReturnType<typeof connectAciWithTransport>> | undefined;
  const client = new BotAci("https://tee.redpill.ai", async options => {
    connection = await connectAciWithTransport(options, () => ({
      observedSpkiSha256: () => pin, close: async () => {},
      fetch: async (input, init) => {
        const request = new Request(input, init);
        if (request.method !== "POST") return Response.json({});
        request.signal.addEventListener("abort", () => { aborted = true; });
        return new Response(new ReadableStream<Uint8Array>({ async pull(controller) {
          await Bun.sleep(1);
          if (request.signal.aborted) { controller.error(new Error("aborted")); return; }
          read += 64 * 1024;
          controller.enqueue(new Uint8Array(64 * 1024));
          if (read >= 24 * 1024 * 1024) controller.close();
        } }), { headers: { "x-receipt-id": "clone-overflow" } });
      },
    }), async () => ({ origin: "https://tee.redpill.ai", hostname: "tee.redpill.ai", report: {}, keyset,
      workloadKeysetDigest: "fixture", tlsSpkiPins: [pin], verifiedAt: Date.now(), expiresAt: Date.now() + 60_000,
      transcript: { verification: { keyset }, lines: [{ id: "id-6", status: "pass" }], verdict: { verified: true } },
    }) as unknown as Identity);
    return connection;
  });
  try {
    const response = await client.fetch("a", "https://tee.redpill.ai/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    await expect(response.text()).rejects.toThrow("model_response_limit");
    await Bun.sleep(10);
    expect(aborted).toBe(true);
    expect(read).toBeLessThanOrEqual(8 * 1024 * 1024 + 2 * 64 * 1024);
    expect(connection!.receipts()[0]).toMatchObject({ responseComplete: true, responseError: "aborted" });
  } finally { await connection?.close(); }
});
