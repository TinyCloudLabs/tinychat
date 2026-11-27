import { afterEach, expect, spyOn, test } from "bun:test";
import { readStatus } from "../courier/denied-chats";
import { MeetingDesk } from "../meeting-reads";
import { botIdFor } from "../owner";

// The backend refuses every POST without this header before any route runs (packages/server/src/csrf.ts), and the
// gateway's reads and refusal reports are POSTs to that backend.
const CSRF = ["x-requested-with", "XMLHttpRequest"] as const;
const owner = `did:pkh:eip155:1:0x${"ab".repeat(20)}`;
const botId = botIdFor(owner);
const conversation = "0".repeat(32);
const secret = "t".repeat(64);

const originalFetch = globalThis.fetch;
const origin = process.env.BACKEND_ORIGIN;
const envSecret = process.env.BOTS_BACKEND_CALL_SECRET;
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (origin === undefined) delete process.env.BACKEND_ORIGIN; else process.env.BACKEND_ORIGIN = origin;
  if (envSecret === undefined) delete process.env.BOTS_BACKEND_CALL_SECRET; else process.env.BOTS_BACKEND_CALL_SECRET = envSecret;
});

test("a read call to the backend carries the CSRF header", async () => {
  const log = spyOn(console, "log").mockImplementation(() => {});
  try {
    const sent: Headers[] = [];
    const desk = new MeetingDesk({
      backendOrigin: "https://backend.invalid", backendCallSecret: secret,
      async fetch(_url, init) {
        sent.push(new Headers(init?.headers));
        return Response.json({ ok: true, text: "[]" });
      },
    });
    desk.push(botId, { owner, conversation, areas: ["meetings"] });
    await desk.call(botId, "tinycloud_find_meetings", {});
    expect(sent).toHaveLength(1);
    expect(sent[0]!.get(CSRF[0])).toBe(CSRF[1]);
    expect(sent[0]!.get("authorization")).toStartWith("TinyCloud-Signed ");
  } finally {
    log.mockRestore();
  }
});

test("a refusal report to the backend carries the CSRF header", async () => {
  const log = spyOn(console, "log").mockImplementation(() => {});
  try {
    const sent: Headers[] = [];
    const desk = new MeetingDesk({
      backendOrigin: "https://backend.invalid", backendCallSecret: secret, forwardRefusals: true,
      async fetch(_url, init) {
        sent.push(new Headers(init?.headers));
        return new Response(null, { status: 204 });
      },
    });
    desk.push(botId, { owner, conversation, areas: [] });
    await desk.call(botId, "tinycloud_find_meetings", {});
    expect(sent).toHaveLength(1);
    expect(sent[0]!.get(CSRF[0])).toBe(CSRF[1]);
  } finally {
    log.mockRestore();
  }
});

test("Courier's owner-settings lookup carries the CSRF header", async () => {
  process.env.BACKEND_ORIGIN = "https://backend.test";
  process.env.BOTS_BACKEND_CALL_SECRET = secret;
  let header: string | null | undefined;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    header = new Headers(init?.headers).get(CSRF[0]);
    return Response.json({ deniedChatIds: [], enabledReadAreas: [] });
  }) as typeof fetch;
  await readStatus(owner);
  expect(header).toBe(CSRF[1]);
});
