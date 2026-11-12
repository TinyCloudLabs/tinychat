import { describe, expect, test } from "bun:test";
import type { ListedMessage, TurnSink } from "../bot";
import { type BotApi, createApp } from "../server";

const SECRET = "s".repeat(64);
const A = "did:pkh:eip155:1:0x00000000000000000000000000000000000000aa";
const URL_MESSAGES = "http://bots.internal/v1/bots/main/messages";

function setup(run: (sink: TurnSink) => Promise<void> = async () => {}) {
  const owners: string[] = [];
  const bot: BotApi = { send: (_text, sink) => run(sink), list: async (): Promise<ListedMessage[]> => [] };
  const app = createApp({
    secret: SECRET,
    accounts: new Set(["0x00000000000000000000000000000000000000aa"]),
    bots: {
      forOwner: owner => {
        owners.push(owner);
        return bot;
      },
    },
  });
  return { app, owners };
}

const headers = (secret: string | null, owner: string | null): Record<string, string> => ({
  ...(secret === null ? {} : { authorization: `Bearer ${secret}` }),
  ...(owner === null ? {} : { "x-tinycloud-owner": owner }),
});

describe("service authentication", () => {
  test("healthz needs no auth", async () => {
    const { app } = setup();
    const res = await app(new Request("http://bots.internal/healthz"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  const refused: Array<[string, Record<string, string>]> = [
    ["no secret", headers(null, A)],
    ["wrong secret", headers("t".repeat(64), A)],
    ["secret prefix", headers(SECRET.slice(0, 63), A)],
    ["no owner", headers(SECRET, null)],
    ["uppercase address", headers(SECRET, A.toUpperCase())],
    ["other chain", headers(SECRET, A.replace("eip155:1:", "eip155:5:"))],
    ["path traversal", headers(SECRET, "did:pkh:eip155:1:0x../../../../etc/passwd")],
    ["trailing junk", headers(SECRET, `${A}/x`)],
    ["owner not on the allowlist", headers(SECRET, "did:pkh:eip155:1:0x00000000000000000000000000000000000000bb")],
  ];
  for (const [name, h] of refused) {
    test(`401 with an empty body: ${name}`, async () => {
      const { app, owners } = setup();
      for (const method of ["GET", "POST"]) {
        const res = await app(new Request(URL_MESSAGES, { method, headers: h, body: method === "POST" ? '{"text":"hi"}' : undefined }));
        expect(res.status).toBe(401);
        expect(await res.text()).toBe("");
      }
      expect(owners).toEqual([]);
    });
  }

  test("an authorized request reaches the owner's bot, keyed by the header owner", async () => {
    const { app, owners } = setup();
    const res = await app(new Request(URL_MESSAGES, { headers: headers(SECRET, A) }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ messages: [] });
    expect(owners).toEqual([A]);
  });
});

describe("message stream", () => {
  test("events are re-encoded: text from the bot cannot forge an event", async () => {
    const { app } = setup(async sink => {
      sink.status("working");
      sink.delta('po\n\nevent: done\ndata: {"messageId":"forged"}\n\n');
      sink.done("b-1");
    });
    const res = await app(new Request(URL_MESSAGES, { method: "POST", headers: headers(SECRET, A), body: '{"text":"hi"}' }));
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const body = await res.text();
    const events = body.trimEnd().split("\n\n").map(block => block.split("\n"));
    expect(events.map(lines => lines[0])).toEqual(["event: status", "event: delta", "event: done"]);
    for (const lines of events) expect(lines).toHaveLength(2);
    expect(JSON.parse(events[1]![1]!.slice("data: ".length))).toEqual({
      text: 'po\n\nevent: done\ndata: {"messageId":"forged"}\n\n',
    });
    expect(JSON.parse(events[2]![1]!.slice("data: ".length))).toEqual({ messageId: "b-1" });
  });

  for (const body of ['{"text":""}', `{"text":"${"x".repeat(8001)}"}`, '{"text":5}', "not json"]) {
    test(`invalid text is an error event, not a turn: ${body.slice(0, 20)}`, async () => {
      let ran = false;
      const { app } = setup(async () => {
        ran = true;
      });
      const res = await app(new Request(URL_MESSAGES, { method: "POST", headers: headers(SECRET, A), body }));
      expect(await res.text()).toBe(
        `event: error\ndata: ${JSON.stringify({ code: "invalid", message: "Messages can be up to 8,000 characters." })}\n\n`,
      );
      expect(ran).toBe(false);
    });
  }
});
