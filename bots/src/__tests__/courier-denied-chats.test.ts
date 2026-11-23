import { afterEach, expect, test } from "bun:test";
import { deniedChatIds, enabledReadAreas, readStatus } from "../courier/denied-chats";
import { NonceGuard, verifyCall } from "../signed-call";

const originalFetch = globalThis.fetch;
const origin = process.env.BACKEND_ORIGIN;
const secret = process.env.BOTS_BACKEND_CALL_SECRET;
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (origin === undefined) delete process.env.BACKEND_ORIGIN; else process.env.BACKEND_ORIGIN = origin;
  if (secret === undefined) delete process.env.BOTS_BACKEND_CALL_SECRET; else process.env.BOTS_BACKEND_CALL_SECRET = secret;
});
const owner = "did:pkh:eip155:1:0x" + "ab".repeat(20);

test("deniedChatIds signs a fresh owner-scoped request and returns the backend's exact ids", async () => {
  process.env.BACKEND_ORIGIN = "https://backend.test";
  process.env.BOTS_BACKEND_CALL_SECRET = "s".repeat(64);
  let denied = ["one"];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    expect(String(url)).toBe("https://backend.test/api/internal/bots/main/reads/read_status");
    const claims = verifyCall(new Headers(init?.headers).get("authorization")!, {
      method: "POST", path: "/api/internal/bots/main/reads/read_status", body: String(init?.body),
    }, { secret: "s".repeat(64), direction: "to-backend", environment: "private", nonces: new NonceGuard() });
    expect(claims?.owner).toBe(owner);
    expect(init?.redirect).toBe("error");
    return Response.json({ deniedChatIds: denied, enabledReadAreas: ["feed_chats"] });
  }) as typeof fetch;
  expect(await deniedChatIds(owner)).toEqual(new Set(["one"]));
  denied = ["two", "three"];
  expect(await deniedChatIds(owner)).toEqual(new Set(["two", "three"]));
  expect(await enabledReadAreas(owner)).toEqual(["feed_chats"]);
  expect(await readStatus(owner)).toEqual({ enabledReadAreas: ["feed_chats"], deniedChatIds: new Set(["two", "three"]) });
});

test("missing authority or malformed responses never turn denial lookup failures into an empty allow list", async () => {
  process.env.BACKEND_ORIGIN = "https://backend.test";
  process.env.BOTS_BACKEND_CALL_SECRET = "s".repeat(64);
  for (const body of [{}, { deniedChatIds: [4], enabledReadAreas: [] }, { deniedChatIds: [""], enabledReadAreas: [] }, { deniedChatIds: ["x".repeat(129)], enabledReadAreas: [] }, { deniedChatIds: [], enabledReadAreas: ["unrecognized"] }]) {
    globalThis.fetch = (async () => Response.json(body)) as typeof fetch;
    await expect(deniedChatIds(owner)).rejects.toThrow();
  }
  globalThis.fetch = (async () => new Response(null, { status: 503 })) as typeof fetch;
  await expect(deniedChatIds(owner)).rejects.toThrow();
  delete process.env.BOTS_BACKEND_CALL_SECRET;
  await expect(deniedChatIds(owner)).rejects.toThrow();
});
