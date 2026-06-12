import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { resolve } from "path";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import type Stripe from "stripe";
import { recoverMessageAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { _resetCatalogCache } from "../billing/catalog.js";
import { _resetCreditsWarnings } from "../billing/credits.js";
import { _resetCache, _setStripeClient } from "../billing/stripe.js";
import { _resetUsage } from "../billing/usage.js";
import {
  buildRelaySignatureFrame,
  createChatRouter,
  relayContentSha256,
  relaySignMessage,
} from "../routes/chat.js";

// ── Shared fixture (read by BOTH backend and frontend tests — hard constraint 3).
// A realistic multi-chunk RedPill SSE stream with reasoning_content deltas
// (EXCLUDED from the preimage), content deltas, a usage chunk, and [DONE].
const FIXTURE_PATH = resolve(import.meta.dir, "../../../test/fixtures/relay-stream.sse");
const FIXTURE = readFileSync(FIXTURE_PATH, "utf-8");

// The preimage is the concatenation of every choices[0].delta.content string, in
// order — and ONLY those. The reasoning_content deltas and the empty role-chunk
// content contribute nothing. This literal is the parity anchor the frontend
// renderedText test must also equal for the SAME fixture file.
const EXPECTED_PREIMAGE = "Hello, world!";
const EXPECTED_COMPLETION_ID = "chatcmpl-relayfixture001";
const FIXTURE_MODEL = "phala/gpt-oss-120b";

// Deterministic throwaway secp256k1 key. signMessage (RFC6979) is deterministic,
// so the produced signature recovers stably to this account's address.
const TEST_PRIVATE_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const account = privateKeyToAccount(TEST_PRIVATE_KEY);

const DONE_EVENT = "data: [DONE]\n\n";
const ORIGINAL_ENV = { ...process.env };
const ADDR = "0xabc";
const MINI_PRICING = { prompt: "0.00000025", completion: "0.000002" };

function authStub(req: Request, _res: Response, next: NextFunction) {
  req.user = { address: ADDR };
  next();
}

function createApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/chat", authStub, createChatRouter({ privateKey: TEST_PRIVATE_KEY }));
  return app;
}

async function request(app: express.Express, path: string, init?: RequestInit) {
  const server = await new Promise<import("http").Server>((res) => {
    const instance = app.listen(0, () => res(instance));
  });
  const { port } = server.address() as { port: number };
  try {
    return await fetch(`http://localhost:${port}${path}`, init);
  } finally {
    await new Promise<void>((res, reject) =>
      server.close((error) => (error ? reject(error) : res())),
    );
  }
}

/** Free-tier Stripe stub. The paywall is enabled so the pre-stream `await`s
 *  (resolveTier/getCatalog) run — mirrors the recording tests' streaming path. */
function mockStripe(): Stripe {
  return {
    customers: { search: async () => ({ data: [] }) },
    subscriptions: { list: async () => ({ data: [] }) },
  } as unknown as Stripe;
}

/** Split a string into `n` roughly-even byte chunks so chunk boundaries fall in
 *  arbitrary mid-line positions (incl. straddling the [DONE] terminator). */
function chunkify(text: string, n: number): Uint8Array[] {
  const bytes = new TextEncoder().encode(text);
  const out: Uint8Array[] = [];
  const size = Math.ceil(bytes.length / n);
  for (let i = 0; i < bytes.length; i += size) out.push(bytes.subarray(i, i + size));
  return out;
}

function streamResponse(chunks: Uint8Array[]): globalThis.Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function erroringResponse(chunks: Uint8Array[]): globalThis.Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      const err = new Error("client disconnected");
      err.name = "AbortError";
      controller.error(err);
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

/** Stub fetch: RedPill /models (catalog) + /chat/completions (the given body). */
function stubChatFetch(makeChatResponse: () => globalThis.Response): () => void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("api.redpill.ai") && url.endsWith("/models")) {
      return new Response(JSON.stringify({ data: [{ id: FIXTURE_MODEL, pricing: MINI_PRICING }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("api.redpill.ai") && url.endsWith("/chat/completions")) {
      return makeChatResponse();
    }
    return originalFetch(input, init);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = originalFetch;
  };
}

function chatBody(model = FIXTURE_MODEL) {
  return JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] });
}

/** Parse a single `data: {...}\n\n` relay-signature frame text. */
function parseFrame(frameText: string) {
  expect(frameText.startsWith("data: ")).toBe(true);
  expect(frameText.endsWith("\n\n")).toBe(true);
  const json = frameText.slice("data: ".length, frameText.length - 2);
  return JSON.parse(json).tinychat_relay_signature as {
    v: number;
    completion_id: string;
    model: string;
    content_sha256: string;
    signature: `0x${string}`;
    address: string;
  };
}

/** The frame text from a clean-end forwarded stream (between forwarded content
 *  and the re-emitted [DONE]). */
function frameTextFrom(forwarded: string): string {
  const beforeDone = FIXTURE.slice(0, FIXTURE.indexOf("data: [DONE]"));
  return forwarded.slice(beforeDone.length, forwarded.length - DONE_EVENT.length);
}

beforeEach(() => {
  process.env.REDPILL_API_KEY = "sk-rp-test";
  process.env.PAYWALL_ENABLED = "true";
  process.env.STRIPE_SECRET_KEY = "sk_test_x";
  _resetCache();
  _resetUsage();
  _resetCatalogCache();
  _resetCreditsWarnings();
  _setStripeClient(mockStripe());
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  _setStripeClient(null);
  _resetCache();
  _resetUsage();
  _resetCatalogCache();
  _resetCreditsWarnings();
});

describe("UsageScanner preimage parity (hard constraint 3)", () => {
  test("the relay signs sha256 over exactly the content-delta concatenation", async () => {
    // Drive the real router with the fixture and recover the signed sha256. sha256
    // is injective over our inputs, so content_sha256 === sha256(EXPECTED_PREIMAGE)
    // proves UsageScanner.completionText accumulated exactly EXPECTED_PREIMAGE —
    // the parity anchor the frontend renderedText test must also equal.
    const restore = stubChatFetch(() => streamResponse(chunkify(FIXTURE, 7)));
    try {
      const res = await request(createApp(), "/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: chatBody(),
      });
      const text = await res.text();
      const frame = parseFrame(frameTextFrom(text));
      expect(frame.content_sha256).toBe(await relayContentSha256(EXPECTED_PREIMAGE));
      expect(frame.completion_id).toBe(EXPECTED_COMPLETION_ID);
    } finally {
      restore();
    }
  });

  test("reasoning_content deltas are excluded from the signed preimage", async () => {
    // The fixture's reasoning_content ("The user said hello. …") must NOT change
    // the hash: sha256(EXPECTED_PREIMAGE) is over content deltas only.
    const sha = await relayContentSha256(EXPECTED_PREIMAGE);
    const withReasoning = await relayContentSha256(
      "The user said hello. I will greet them back." + EXPECTED_PREIMAGE,
    );
    expect(sha).not.toBe(withReasoning);
  });
});

describe("relay signature frame (clean end)", () => {
  test("frame is emitted immediately before [DONE]; forwarded bytes byte-identical except terminator", async () => {
    const restore = stubChatFetch(() => streamResponse(chunkify(FIXTURE, 5)));
    try {
      const res = await request(createApp(), "/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: chatBody(),
      });
      expect(res.status).toBe(200);
      const text = await res.text();

      // Exactly one terminator survives — the upstream one was held back and we
      // re-emitted a single [DONE] after the frame (hard constraint 6).
      expect(text.split(DONE_EVENT).length - 1).toBe(1);
      expect(text.endsWith(DONE_EVENT)).toBe(true);

      // Everything before the frame is byte-identical to the fixture's pre-[DONE]
      // bytes — the ONLY permitted mutation is the terminator handling.
      const beforeDone = FIXTURE.slice(0, FIXTURE.indexOf("data: [DONE]"));
      expect(text.startsWith(beforeDone)).toBe(true);

      // The frame sits between the forwarded content and the re-emitted [DONE].
      const frame = parseFrame(frameTextFrom(text));
      expect(frame.v).toBe(1);
      expect(frame.completion_id).toBe(EXPECTED_COMPLETION_ID);
      expect(frame.model).toBe(FIXTURE_MODEL);
      expect(frame.content_sha256).toBe(await relayContentSha256(EXPECTED_PREIMAGE));
      expect(frame.address).toBe(account.address);
    } finally {
      restore();
    }
  });

  test("signature recovers (viem recoverMessageAddress) to the configured account address", async () => {
    const restore = stubChatFetch(() => streamResponse(chunkify(FIXTURE, 3)));
    try {
      const res = await request(createApp(), "/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: chatBody(),
      });
      const frame = parseFrame(frameTextFrom(await res.text()));
      const message = relaySignMessage(frame.completion_id, frame.model, frame.content_sha256);
      const recovered = await recoverMessageAddress({ message, signature: frame.signature });
      expect(recovered).toBe(account.address);
      expect(frame.address).toBe(account.address);
    } finally {
      restore();
    }
  });
});

describe("relay signature frame (abort/error)", () => {
  test("NO frame and NO [DONE] when the upstream stream ends abnormally", async () => {
    // Two content chunks then a stream error — fail-honest: end without a frame,
    // never a fabricated signature (hard constraint 2).
    const partial = [
      `data: ${JSON.stringify({
        id: EXPECTED_COMPLETION_ID,
        model: FIXTURE_MODEL,
        choices: [{ index: 0, delta: { content: "Hello" } }],
      })}\n\n`,
      `data: ${JSON.stringify({
        id: EXPECTED_COMPLETION_ID,
        model: FIXTURE_MODEL,
        choices: [{ index: 0, delta: { content: ", world" } }],
      })}\n\n`,
    ].map((s) => new TextEncoder().encode(s));
    const restore = stubChatFetch(() => erroringResponse(partial));
    try {
      const res = await request(createApp(), "/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: chatBody(),
      });
      const text = await res.text();
      expect(text).not.toContain("tinychat_relay_signature");
      expect(text).not.toContain("data: [DONE]");
    } finally {
      restore();
    }
  });
});

describe("buildRelaySignatureFrame helper", () => {
  test("uses the normative message format and returns null without a completion id", async () => {
    const frameText = await buildRelaySignatureFrame({
      account,
      completionId: EXPECTED_COMPLETION_ID,
      model: FIXTURE_MODEL,
      completionText: EXPECTED_PREIMAGE,
    });
    expect(frameText).not.toBeNull();
    const frame = parseFrame(frameText!);
    const sha = await relayContentSha256(EXPECTED_PREIMAGE);
    expect(frame.content_sha256).toBe(sha);
    expect(relaySignMessage(EXPECTED_COMPLETION_ID, FIXTURE_MODEL, sha)).toBe(
      `tinychat-relay-sign-v1:${EXPECTED_COMPLETION_ID}:${FIXTURE_MODEL}:${sha}`,
    );

    // No completion id → nothing to bind → null (caller still forwards [DONE]).
    const none = await buildRelaySignatureFrame({
      account,
      completionId: null,
      model: FIXTURE_MODEL,
      completionText: EXPECTED_PREIMAGE,
    });
    expect(none).toBeNull();
  });
});
