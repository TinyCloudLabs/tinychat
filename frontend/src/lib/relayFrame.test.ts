import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { resolve } from "path";

import { parseRelayFrame, relaySignMessage, type RelaySignatureFrame } from "./relayFrame";
import { streamChat } from "./chatApi";
// The backend's OWN hash + message builders — imported so the parity assertions
// below tie the frontend to the SAME functions that produced the signature, not
// a re-implementation of them (hard constraint 3 / precedence rule 3). Test
// files are excluded from `build:frontend` (tsconfig), so this cross-package
// import never reaches the shipped bundle.
import {
  relayContentSha256,
  relaySignMessage as backendRelaySignMessage,
} from "../../../backend/src/routes/chat.ts";

// ── Shared fixture (read by BOTH backend and frontend tests — hard constraint 3).
const FIXTURE_PATH = resolve(import.meta.dir, "../../../test/fixtures/relay-stream.sse");
const FIXTURE = readFileSync(FIXTURE_PATH, "utf-8");

const FIXTURE_MODEL = "phala/gpt-oss-120b";
const FIXTURE_COMPLETION_ID = "chatcmpl-relayfixture001";

const sessionStore = {
  getToken: () => "token",
  isExpired: () => false,
  clear: () => {},
} as never;

const realFetch = globalThis.fetch;

/**
 * Drive the REAL frontend SSE path (`streamChat`) over an SSE body and return
 * the final cumulative rendered text plus any relay frame it surfaced. This is
 * the exact text the badge's `renderedText` reflects, so hashing it is the
 * verifier-side preimage.
 */
async function renderViaStreamChat(
  body: string,
): Promise<{ text: string; frame: RelaySignatureFrame | null }> {
  globalThis.fetch = (async () =>
    new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    })) as typeof fetch;
  try {
    let text = "";
    let frame: RelaySignatureFrame | null = null;
    for await (const t of streamChat({
      backendUrl: "http://backend.test",
      sessionStore,
      model: FIXTURE_MODEL,
      messages: [{ role: "user", content: "hi" }],
      onRelaySignature: (f) => {
        frame = f;
      },
    })) {
      text = t;
    }
    return { text, frame };
  } finally {
    globalThis.fetch = realFetch;
  }
}

/**
 * Reference reconstruction of the BACKEND preimage from the SAME fixture —
 * mirrors `UsageScanner.completionText` (concatenation of every
 * `choices[0].delta.content`; reasoning_content and empty deltas contribute
 * nothing). Kept deliberately independent of the frontend path so the parity
 * assertion compares two separate reconstructions of one shared fixture.
 */
function backendPreimageFromFixture(fixture: string): string {
  let out = "";
  for (const rawLine of fixture.split("\n")) {
    const line = rawLine.trim();
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (payload === "" || payload === "[DONE]") continue;
    let parsed: { choices?: Array<{ delta?: { content?: unknown } }> };
    try {
      parsed = JSON.parse(payload);
    } catch {
      continue;
    }
    const delta = parsed.choices?.[0]?.delta?.content;
    if (typeof delta === "string") out += delta;
  }
  return out;
}

describe("preimage parity over the shared fixture (hard constraint 3)", () => {
  test("frontend renderedText hashes to exactly the backend's signed sha256", async () => {
    const { text: renderedText } = await renderViaStreamChat(FIXTURE);
    const backendPreimage = backendPreimageFromFixture(FIXTURE);

    // Both reconstructions of the SAME fixture must be byte-equal — the lesson
    // of the RedPill post-mortem (the verifier could not reproduce the preimage).
    expect(renderedText).toBe("Hello, world!");
    expect(renderedText).toBe(backendPreimage);

    // ...and hashing the frontend renderedText with the BACKEND's own hash fn
    // reproduces the value the relay would sign. reasoning_content is excluded.
    const renderedHash = await relayContentSha256(renderedText);
    expect(renderedHash).toBe(await relayContentSha256(backendPreimage));
    expect(renderedHash).not.toBe(
      await relayContentSha256("The user said hello. I will greet them back." + renderedText),
    );
  });

  test("the reconstructed message matches the backend's normative format byte-for-byte", async () => {
    const { text: renderedText } = await renderViaStreamChat(FIXTURE);
    const renderedHash = await relayContentSha256(renderedText);
    const frame = {
      completion_id: FIXTURE_COMPLETION_ID,
      model: FIXTURE_MODEL,
      content_sha256: renderedHash,
    };

    const message = relaySignMessage(frame);
    expect(message).toBe(`tinychat-relay-sign-v1:${FIXTURE_COMPLETION_ID}:${FIXTURE_MODEL}:${renderedHash}`);
    // Precedence rule 3: the frontend builder must equal the backend builder.
    expect(message).toBe(
      backendRelaySignMessage(FIXTURE_COMPLETION_ID, FIXTURE_MODEL, renderedHash),
    );
  });
});

describe("relay frame capture on the shared fixture (hard constraint 7, both skew directions)", () => {
  test("old-BE fixture (no frame) → no relay signature, text rendered unchanged", async () => {
    // The shared fixture is a plain upstream stream with NO relay frame — the
    // new-FE / old-BE case. The frame is absent and rendering is unaffected.
    const { text, frame } = await renderViaStreamChat(FIXTURE);
    expect(frame).toBeNull();
    expect(text).toBe("Hello, world!");
  });

  test("new-BE fixture (frame before [DONE]) → frame captured, text identical", async () => {
    // Splice a relay frame in just before [DONE] (what the new backend emits) —
    // the new-FE / new-BE case. Rendered text is byte-identical to the no-frame
    // render; the frame is surfaced off the text path.
    const signed: RelaySignatureFrame = {
      v: 1,
      completion_id: FIXTURE_COMPLETION_ID,
      model: FIXTURE_MODEL,
      content_sha256: await relayContentSha256("Hello, world!"),
      signature: "0xsig",
      address: "0xRELAY",
    };
    const withFrame = FIXTURE.replace(
      "data: [DONE]",
      `data: ${JSON.stringify({ tinychat_relay_signature: signed })}\n\ndata: [DONE]`,
    );

    const { text, frame } = await renderViaStreamChat(withFrame);
    expect(text).toBe("Hello, world!");
    expect(frame).toEqual(signed);
  });
});

describe("parseRelayFrame (pure, never throws)", () => {
  const valid: RelaySignatureFrame = {
    v: 1,
    completion_id: "cid",
    model: "phala/gpt-oss-120b",
    content_sha256: "abc",
    signature: "0xsig",
    address: "0xaddr",
  };

  test("recognizes a well-formed envelope", () => {
    expect(parseRelayFrame({ tinychat_relay_signature: valid })).toEqual(valid);
  });

  test("returns null for a normal completion chunk (no rendering impact)", () => {
    expect(parseRelayFrame({ id: "x", choices: [{ delta: { content: "hi" } }] })).toBeNull();
    expect(parseRelayFrame({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 2 } })).toBeNull();
  });

  test("returns null for malformed envelopes and non-objects, never throwing", () => {
    expect(parseRelayFrame({ tinychat_relay_signature: { v: 1 } })).toBeNull();
    expect(parseRelayFrame({ tinychat_relay_signature: { ...valid, v: "1" } })).toBeNull();
    expect(parseRelayFrame({ tinychat_relay_signature: null })).toBeNull();
    expect(parseRelayFrame(null)).toBeNull();
    expect(parseRelayFrame("nope")).toBeNull();
    expect(parseRelayFrame(42)).toBeNull();
  });
});
