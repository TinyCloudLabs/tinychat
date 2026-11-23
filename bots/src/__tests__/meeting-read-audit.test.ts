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
