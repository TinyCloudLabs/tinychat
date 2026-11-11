import { describe, expect, test } from "bun:test";
import type { AciConnection, AciReceiptAudit, ConnectAciOptions } from "@phala/aci-verifier/runtime";
import { createRedPillAciFetch, RedPillAttestationError, validateRedPillBaseUrl } from "../redpill-aci.js";

const BASE_URL = "https://tee.redpill.ai/v1";
const RECEIPT_ID = "fixture-receipt-001";
const VERIFIED_AUDIT = {
  receiptId: RECEIPT_ID,
  transcript: { verdict: { verified: true } },
} as AciReceiptAudit;

function connectionFixture(options: {
  identityVerified?: boolean;
  responseHeaders?: HeadersInit;
  responseBody?: BodyInit | null;
  audit?: AciReceiptAudit;
  verifyReceipt?: (id?: string) => Promise<AciReceiptAudit>;
}) {
  const calls: Array<{ url: string; body: string }> = [];
  const verified: string[] = [];
  const connection = {
    baseURL: BASE_URL,
    identity: { transcript: { verdict: { verified: options.identityVerified ?? true } } },
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), body: String(init?.body ?? "") });
      return new Response(options.responseBody === undefined ? "data: [DONE]\n\n" : options.responseBody, {
        headers: { "content-type": "text/event-stream", "x-receipt-id": RECEIPT_ID, ...Object.fromEntries(new Headers(options.responseHeaders)) },
      });
    },
    verifyReceipt: async (id?: string) => {
      verified.push(id ?? "");
      return options.verifyReceipt ? options.verifyReceipt(id) : options.audit ?? VERIFIED_AUDIT;
    },
    receipts: () => [],
    refresh: async () => {},
    close: async () => {},
  } as unknown as AciConnection;
  return { connection, calls, verified };
}
 
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
 
describe("RedPill ACI fetch", () => {
  test("makes model bytes available before awaiting the receipt verdict", async () => {
    const verdict = deferred<AciReceiptAudit>();
    const verificationStarted = deferred<void>();
    const fixture = connectionFixture({
      responseBody: `data: ${JSON.stringify({ choices: [{ delta: { content: "available before audit" } }] })}\n\ndata: [DONE]\n\n`,
      verifyReceipt: async () => {
        verificationStarted.resolve();
        return verdict.promise;
      },
    });
    const fetch = createRedPillAciFetch(BASE_URL, async () => fixture.connection);
    const responsePromise = fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      body: JSON.stringify({ model: "z-ai/glm-5.3", messages: [] }),
    });
    const first = await Promise.race([
      responsePromise.then((response) => ({ kind: "response" as const, response })),
      verificationStarted.promise.then(() => ({ kind: "verification" as const })),
    ]);
    expect(first.kind).toBe("response");
    if (first.kind === "response") {
      const reader = first.response.body!.getReader();
      try {
        const chunk = await reader.read();
        expect(new TextDecoder().decode(chunk.value)).toContain("available before audit");

        const end = reader.read();
        await verificationStarted.promise;
        let ended = false;
        void end.then(() => { ended = true; });
        await Promise.resolve();
        expect(ended).toBe(false);
        verdict.resolve(VERIFIED_AUDIT);
        const terminal = await end;
        expect(terminal.done).toBe(false);
        const terminalText = new TextDecoder().decode(terminal.value);
        expect(terminalText).toContain('"receipt_verification":{"status":"verified"}');
        expect(terminalText).toContain("data: [DONE]");
        expect(await reader.read()).toEqual({ done: true, value: undefined });
      } finally {
        reader.releaseLock();
      }
    } else {
      verdict.resolve(VERIFIED_AUDIT);
    }
    await responsePromise;
  });
 
  test("streams bytes, then errors the body when the receipt verdict fails", async () => {
    const fixture = connectionFixture({
      responseBody: `data: ${JSON.stringify({ choices: [{ delta: { content: "visible before failed audit" } }] })}\n\ndata: [DONE]\n\n`,
      audit: { ...VERIFIED_AUDIT, transcript: { verdict: { verified: false } } } as AciReceiptAudit,
    });
    const fetch = createRedPillAciFetch(BASE_URL, async () => fixture.connection);
    const response = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      body: JSON.stringify({ model: "z-ai/glm-5.3", messages: [] }),
    });
    const reader = response.body!.getReader();
    try {
      expect(new TextDecoder().decode((await reader.read()).value)).toContain("visible before failed audit");
      await expect(reader.read()).rejects.toBeInstanceOf(RedPillAttestationError);
      expect(fixture.verified).toEqual([RECEIPT_ID]);
    } finally {
      reader.releaseLock();
    }
  });
 
  test("refuses a successful completion without a receipt id", async () => {
    const fixture = connectionFixture({ responseHeaders: { "x-receipt-id": "" } });
    const fetch = createRedPillAciFetch(BASE_URL, async () => fixture.connection);
 
    await expect(fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      body: JSON.stringify({ model: "z-ai/glm-5.3", messages: [] }),
    })).rejects.toBeInstanceOf(RedPillAttestationError);
    expect(fixture.verified).toEqual([]);
  });
  test("adds the verified-upstream constraint and audits the exact response receipt", async () => {
    const fixture = connectionFixture({});
    let optionsSeen: ConnectAciOptions | undefined;
    const fetch = createRedPillAciFetch(BASE_URL, async (options) => {
      optionsSeen = options;
      return fixture.connection;
    });

    const response = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "z-ai/glm-5.3", messages: [{ role: "user", content: "fixture prompt" }] }),
    });

    expect(optionsSeen).toMatchObject({ baseURL: BASE_URL, serving: { requireVerified: true, requireReceipt: true } });
    expect(JSON.parse(fixture.calls[0].body).provider).toEqual({ aci_verified: true });
    expect(await response.text()).toBe(`data: ${JSON.stringify({ receipt_verification: { status: "verified" } })}\n\ndata: [DONE]\n\n`);
    expect(fixture.verified).toEqual([RECEIPT_ID]);
  });


  test("refuses a model request if the gateway identity is not verified", async () => {
    const fixture = connectionFixture({ identityVerified: false });
    const fetch = createRedPillAciFetch(BASE_URL, async () => fixture.connection);

    await expect(fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      body: JSON.stringify({ model: "z-ai/glm-5.3", messages: [] }),
    })).rejects.toBeInstanceOf(RedPillAttestationError);
    expect(fixture.calls).toEqual([]);
  });

  test("allows only the TLS attested gateway origin", () => {
    expect(validateRedPillBaseUrl("https://tee.redpill.ai/v1")).toBe("https://tee.redpill.ai/v1");
    for (const url of [
      "https://api.redpill.ai/v1",
      "http://tee.redpill.ai/v1",
      "https://tee.redpill.ai.attacker.invalid/v1",
      "https://user@tee.redpill.ai/v1",
    ]) {
      expect(() => validateRedPillBaseUrl(url)).toThrow();
    }
  });
});
