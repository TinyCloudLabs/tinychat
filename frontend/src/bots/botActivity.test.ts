import { expect, test } from "bun:test";

import { createBotChatApi } from "./botChatApi";
import { createMainEventParser, type BotMessage, type MainEvent } from "./botsApi";
import { createBotChats, type BotChatSource } from "./useBotChat";

const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
const ID = (n: number) => n.toString(16).padStart(32, "0");
const record = (n: number, verb: string, count: number, at: string) => ({ type: "activity", id: ID(n), verb, count, at });
const AT = (seconds: number) => `2026-11-18T23:00:${String(seconds).padStart(2, "0")}.000Z`;

function parse(text: string): MainEvent[] {
  const events: MainEvent[] = [];
  createMainEventParser((event) => events.push(event))(text);
  return events;
}

test("an activity event reaches the view with its typed record; one that does not check out is dropped, and the turn goes on", () => {
  const good = record(1, "ran_commands", 3, AT(1));
  const events = parse([
    `event: activity\ndata: ${JSON.stringify(good)}\n\n`,
    `event: activity\ndata: ${JSON.stringify({ ...good, verb: "wrote_poems" })}\n\n`,
    `event: activity\ndata: ${JSON.stringify({ ...good, count: 0 })}\n\n`,
    `event: activity\ndata: ${JSON.stringify({ ...good, text: "rm -rf /" })}\n\n`,
    `event: activity\ndata: ${JSON.stringify({ ...good, id: "../etc" })}\n\n`,
    `event: done\ndata: {"messageId":"m1"}\n\n`,
  ].join(""));
  expect(events).toEqual([
    { type: "activity", activity: { id: ID(1), verb: "ran_commands", count: 3, at: AT(1) } },
    { type: "done", messageId: "m1" },
  ]);
});

test("the list read returns the activity records beside the messages, keeping only well-formed ones", async () => {
  const api = createBotChatApi({
    baseUrl: "https://api.example",
    getToken: () => "token",
    fetch: async () => Response.json({
      messages: [{ id: "1", role: "bot", text: "Hi", at: AT(0) }],
      activity: [record(1, "changed_files", 1, AT(2)), { type: "activity", id: "x" }, "nonsense"],
    }),
  });
  expect(await api.listConversation!("main")).toEqual({
    messages: [{ id: "1", role: "bot", text: "Hi", at: AT(0) }],
    activity: [{ id: ID(1), verb: "changed_files", count: 1, at: AT(2) }],
  });
});

test("a list without an activity field has none", async () => {
  const api = createBotChatApi({ baseUrl: "https://api.example", getToken: () => "token", fetch: async () => Response.json({ messages: [] }) });
  expect((await api.listConversation!("main")).activity).toEqual([]);
});

const messages: BotMessage[] = [
  { id: "u1", role: "user", text: "Fix it", at: AT(0) },
  { id: "b1", role: "bot", text: "Done", at: AT(10) },
  { id: "u2", role: "user", text: "Again", at: AT(20) },
  { id: "b2", role: "bot", text: "Done again", at: AT(30) },
];

function fakeBot(activity: { id: string; verb: "ran_commands" | "changed_files"; count: number; at: string }[] = []) {
  const turns: { emit: (event: MainEvent) => void; finish: () => void }[] = [];
  const source: BotChatSource = {
    list: async () => messages,
    listConversation: async () => ({ messages, activity }),
    send: (_text, onEvent) => {
      const { promise, resolve } = Promise.withResolvers<void>();
      turns.push({ emit: onEvent, finish: resolve });
      return promise;
    },
  };
  return { source, turns };
}

test("after a reload each activity line sits after the last message that came before it, oldest first", async () => {
  const chats = createBotChats(() => fakeBot([
    { id: ID(3), verb: "ran_commands", count: 1, at: AT(25) },
    { id: ID(1), verb: "ran_commands", count: 2, at: AT(5) },
    { id: ID(2), verb: "changed_files", count: 1, at: AT(8) },
    { id: ID(1), verb: "ran_commands", count: 2, at: AT(5) },
  ]).source);
  await chats.ensureHistory("main");
  expect(chats.activity("main").map(({ id, after, inTurn }) => [id, after, inTurn])).toEqual([
    [ID(1), "u1", false],
    [ID(2), "u1", false],
    [ID(3), "u2", false],
  ]);
  chats.dispose();
});

test("a line that came during a turn shows with that turn, then stays after the turn's message once the reply is in", async () => {
  const fake = fakeBot();
  const chats = createBotChats(() => fake.source);
  void chats.send("main", "Run the tests");
  await flush();
  const live = { id: ID(9), verb: "ran_commands" as const, count: 4, at: AT(40) };
  fake.turns[0]!.emit({ type: "activity", activity: live });
  fake.turns[0]!.emit({ type: "activity", activity: live });
  expect(chats.activity("main")).toEqual([{ ...live, after: null, inTurn: true }]);

  fake.turns[0]!.emit({ type: "delta", text: "All pass" });
  fake.turns[0]!.emit({ type: "done", messageId: "b3" });
  fake.turns[0]!.finish();
  await flush();
  const lines = chats.get("main").lines;
  const user = lines.find((line) => line.text === "Run the tests")!;
  expect(chats.activity("main")).toEqual([{ ...live, after: user.id, inTurn: false }]);
  expect(lines.at(-1)).toMatchObject({ id: "b3", text: "All pass" });
  chats.dispose();
});

test("a line from a failed turn is kept after that turn's message when the owner sends again", async () => {
  const fake = fakeBot();
  const chats = createBotChats(() => fake.source);
  void chats.send("main", "First");
  await flush();
  const live = { id: ID(7), verb: "changed_files" as const, count: 2, at: AT(41) };
  fake.turns[0]!.emit({ type: "activity", activity: live });
  fake.turns[0]!.emit({ type: "error", code: "model_unavailable" });
  fake.turns[0]!.finish();
  await flush();

  void chats.send("main", "Second");
  await flush();
  const first = chats.get("main").lines.find((line) => line.text === "First")!;
  expect(chats.activity("main")).toEqual([{ ...live, after: first.id, inTurn: false }]);
  chats.dispose();
});
