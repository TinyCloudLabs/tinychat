import { expect, spyOn, test } from "bun:test";
import { MeetingDesk, READ_ERRORS, READS_PER_DAY } from "../meeting-reads";
import { botIdFor } from "../owner";
import { NonceGuard, verifyCall } from "../signed-call";

const backendOrigin = "https://backend.invalid";
const secret = "t".repeat(64);
const owner = `did:pkh:eip155:1:0x${"ab".repeat(20)}`;
const botId = botIdFor(owner);
const tool = "tinycloud_find_meetings";
const conversation = "0".repeat(32);
const path = "/api/internal/bots/main/reads/audit/refusal";

test("forwards off, busy and budget with only signed refusal metadata", async () => {
  const reports: unknown[] = [];
  const nonces = new NonceGuard();
  const inFlight = Promise.withResolvers<Response>();
  let reads = 0;
  const desk = new MeetingDesk({
    backendOrigin, backendCallSecret: secret, forwardRefusals: true,
    async fetch(url, init) {
      if (new URL(url).pathname !== path) {
        reads++;
        return reads === 1 ? inFlight.promise : Response.json({ ok: true, text: "private result" });
      }
      const body = String(init?.body);
      const claims = verifyCall(new Headers(init?.headers).get("authorization"), { method: "POST", path, body }, {
        secret, direction: "to-backend", environment: "private", nonces,
      });
      reports.push({ signedOwner: claims?.owner, body: JSON.parse(body), signal: !!init?.signal });
      return new Response(null, { status: 204 });
    },
  });
  const log = spyOn(console, "log").mockImplementation(() => {});
  try {
    const args = { query: "private query" };
    expect((await desk.call(botId, tool, args)).isError).toBe(true);
    expect(reports).toEqual([]);
    desk.push(botId, { owner, conversation, areas: ["feed_chats"] });
    expect((await desk.call(botId, tool, args)).content[0]?.text).toBe(READ_ERRORS.off);
    desk.push(botId, { owner, conversation, areas: ["meetings"] });
    const first = desk.call(botId, tool, args);
    expect((await desk.call(botId, tool, args)).content[0]?.text).toBe(READ_ERRORS.busy);
    inFlight.resolve(Response.json({ ok: true, text: "private result" }));
    await first;
    for (let i = 1; i < READS_PER_DAY; i++) await desk.call(botId, tool, args);
    expect((await desk.call(botId, tool, args)).content[0]?.text).toBe(READ_ERRORS.budget);
    expect(reads).toBe(READS_PER_DAY);
    expect(reports).toEqual(["off", "busy", "budget"].map(outcome => ({
      signedOwner: owner, body: { owner, area: "meetings", tool, outcome }, signal: true,
    })));
  } finally {
    log.mockRestore();
  }
});

test("a stalled or failed audit forward leaves the bot reply unchanged", async () => {
  const delivery = Promise.withResolvers<Response>();
  const log = spyOn(console, "log").mockImplementation(() => {});
  try {
    const desk = new MeetingDesk({
      backendOrigin, backendCallSecret: secret, forwardRefusals: true, fetch: () => delivery.promise,
    });
    desk.push(botId, { owner, conversation, areas: [] });
    expect(await desk.call(botId, tool, {})).toMatchObject({ isError: true, content: [{ text: READ_ERRORS.off }] });
    delivery.resolve(new Response(null, { status: 503 }));
    await delivery.promise;
    expect(log.mock.calls.filter(([entry]) => entry === '{"gateway":"reads","outcome":"audit_forward_failed"}')).toHaveLength(1);
  } finally {
    log.mockRestore();
  }
});

test("caps refusal reports per bot per UTC day and logs the cap once", async () => {
  let now = Date.parse("2026-11-23T23:59:59.000Z");
  let delivered = 0;
  const log = spyOn(console, "log").mockImplementation(() => {});
  try {
    const desk = new MeetingDesk({
      backendOrigin, backendCallSecret: secret, forwardRefusals: true, now: () => now,
      async fetch() {
        delivered++;
        return new Response(null, { status: 204 });
      },
    });
    desk.push(botId, { owner, conversation, areas: [] });
    for (let i = 0; i < READS_PER_DAY + 3; i++) {
      expect((await desk.call(botId, tool, {})).content[0]?.text).toBe(READ_ERRORS.off);
    }
    expect(delivered).toBe(READS_PER_DAY);
    expect(log.mock.calls.filter(([entry]) => entry === '{"gateway":"reads","outcome":"audit_forward_capped"}')).toHaveLength(1);
    now += 1000;
    await desk.call(botId, tool, {});
    expect(delivered).toBe(READS_PER_DAY + 1);
  } finally {
    log.mockRestore();
  }
});

test("sends concurrent refusal reports for one bot without dropping any", async () => {
  let delivered = 0;
  const response = Promise.withResolvers<Response>();
  const log = spyOn(console, "log").mockImplementation(() => {});
  try {
    const desk = new MeetingDesk({
      backendOrigin, backendCallSecret: secret, forwardRefusals: true,
      fetch() { delivered++; return response.promise; },
    });
    desk.push(botId, { owner, conversation, areas: [] });
    await desk.call(botId, tool, {});
    expect((await desk.call(botId, tool, {})).content[0]?.text).toBe(READ_ERRORS.off);
    expect(delivered).toBe(2);
    response.resolve(new Response(null, { status: 204 }));
    await response.promise;
  } finally {
    log.mockRestore();
  }
});

test("reports a read the backend never answered, with no arguments, and does not retry a refused report", async () => {
  const reports: unknown[] = [];
  let reads = 0;
  let readFails: () => Promise<Response> = async () => new Response(null, { status: 502 });
  const failed = '{"gateway":"reads","outcome":"audit_forward_failed"}';
  const bothLogged = Promise.withResolvers<void>();
  let failures = 0;
  const log = spyOn(console, "log").mockImplementation(entry => {
    if (entry === failed && ++failures === 2) bothLogged.resolve();
  });
  try {
    const desk = new MeetingDesk({
      backendOrigin, backendCallSecret: secret, forwardRefusals: true,
      async fetch(url, init) {
        if (new URL(url).pathname !== path) { reads++; return readFails(); }
        reports.push(JSON.parse(String(init?.body)));
        return new Response(null, { status: 429 });
      },
    });
    desk.push(botId, { owner, conversation, areas: ["meetings"] });
    const args = { query: "private query" };
    expect((await desk.call(botId, tool, args)).content[0]?.text).toBe(READ_ERRORS.unavailable);
    readFails = async () => { throw new Error("connection reset"); };
    expect((await desk.call(botId, tool, args)).content[0]?.text).toBe(READ_ERRORS.unavailable);
    // An answered refusal was already recorded by the backend; an unsigned call never reached a read.
    readFails = async () => Response.json({ ok: false, error: "unavailable" });
    await desk.call(botId, tool, args);
    readFails = async () => new Response(null, { status: 401 });
    await desk.call(botId, tool, args);
    await bothLogged.promise;
    expect(reads).toBe(4);
    expect(reports).toEqual([
      { owner, area: "meetings", tool, outcome: "unavailable" },
      { owner, area: "meetings", tool, outcome: "unavailable" },
    ]);
    const lines = log.mock.calls.map(([entry]) => String(entry));
    expect(lines.filter(line => line === failed)).toHaveLength(2);
    expect(lines.join("\n")).not.toContain(owner);
    expect(lines.join("\n")).not.toContain("private query");
  } finally {
    log.mockRestore();
  }
});

test("a gateway without a call secret reads nothing and reports nothing", async () => {
  let calls = 0;
  const log = spyOn(console, "log").mockImplementation(() => {});
  try {
    const desk = new MeetingDesk({
      backendOrigin, backendCallSecret: undefined, forwardRefusals: true,
      async fetch() { calls++; return new Response(null, { status: 204 }); },
    });
    desk.push(botId, { owner, conversation, areas: ["meetings"] });
    expect((await desk.call(botId, tool, { query: "private query" })).content[0]?.text).toBe(READ_ERRORS.unavailable);
    expect(calls).toBe(0);
    const lines = log.mock.calls.map(([entry]) => String(entry)).join("\n");
    expect(lines).toContain('"outcome":"no_secret"');
    expect(lines).not.toContain(owner);
    expect(lines).not.toContain("private query");
  } finally {
    log.mockRestore();
  }
});
