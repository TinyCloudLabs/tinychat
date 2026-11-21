import { expect, test } from "bun:test";

import { BotsError, type BotMessage, type MainEvent } from "./botsApi";
import { createBotChats, type BotChatSource } from "./useBotChat";

const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };

/** A bot whose replies the test finishes by hand. */
function fakeBot(earlier: BotMessage[] = []) {
  const turns: { text: string; emit: (event: MainEvent) => void; finish: () => void; fail: (error: unknown) => void; signal?: AbortSignal }[] = [];
  let lists = 0;
  const source: BotChatSource = {
    list: async () => { lists++; return earlier; },
    send: (text, onEvent, signal) => {
      const { promise, resolve, reject } = Promise.withResolvers<void>();
      turns.push({ text, emit: onEvent, finish: resolve, fail: reject, signal });
      return promise;
    },
  };
  return { source, turns, lists: () => lists };
}

test("a turn survives switching to another bot, and its reply is marked unseen until its bot is shown again", async () => {
  const research = fakeBot();
  const main = fakeBot([{ id: "m1", role: "bot", text: "Earlier", at: "" }]);
  const chats = createBotChats((key) => (key === "main" ? main.source : research.source));

  chats.view("a".repeat(32));
  void chats.send("a".repeat(32), "Find three sources");
  await flush();
  research.turns[0]!.emit({ type: "delta", text: "Here are" });

  // The owner switches to Main while Research is still answering, and talks to Main.
  chats.view("main");
  void chats.send("main", "Hello");
  await flush();
  expect(chats.get("a".repeat(32)).turn).toMatchObject({ text: "Find three sources", reply: "Here are", state: "working" });
  expect(research.turns[0]!.signal?.aborted).toBe(false);

  research.turns[0]!.emit({ type: "delta", text: " three." });
  research.turns[0]!.emit({ type: "done", messageId: "r1" });
  research.turns[0]!.finish();
  await flush();
  const research1 = chats.get("a".repeat(32));
  expect(research1.turn).toBeNull();
  expect(research1.lines.map((line) => [line.role, line.text])).toEqual([["user", "Find three sources"], ["bot", "Here are three."]]);
  expect(research1.unseen).toBe(true);
  // Main's own turn is untouched by the other bot's.
  expect(chats.get("main").turn).toMatchObject({ text: "Hello", state: "starting" });
  expect(chats.get("main").lines.map((line) => line.text)).toEqual(["Earlier"]);

  chats.view("a".repeat(32));
  expect(chats.get("a".repeat(32)).unseen).toBe(false);
});

test("a reply that arrives while its bot is on screen is not unseen", async () => {
  const bot = fakeBot();
  const chats = createBotChats(() => bot.source);
  chats.view("main");
  void chats.send("main", "Hi");
  await flush();
  bot.turns[0]!.emit({ type: "done", messageId: "x" });
  bot.turns[0]!.finish();
  await flush();
  expect(chats.get("main").unseen).toBe(false);
});

test("one turn at a time per bot, and Try again sends the failed message once more", async () => {
  const bot = fakeBot();
  const chats = createBotChats(() => bot.source);
  void chats.send("main", "First");
  void chats.send("main", "Second, while the first runs");
  await flush();
  expect(bot.turns.map((turn) => turn.text)).toEqual(["First"]);

  bot.turns[0]!.fail(new BotsError("model_unavailable"));
  await flush();
  expect(chats.get("main").turn).toMatchObject({ text: "First", state: "error", error: "model_unavailable" });

  chats.retry("main");
  await flush();
  expect(bot.turns.map((turn) => turn.text)).toEqual(["First", "First"]);
  // A retry does not leave the failed copy behind as a line of its own.
  expect(chats.get("main").lines).toEqual([]);
});

test("a new message after a failure keeps the failed one in the conversation", async () => {
  const bot = fakeBot();
  const chats = createBotChats(() => bot.source);
  void chats.send("main", "Lost");
  await flush();
  bot.turns[0]!.emit({ type: "error", code: "busy" });
  bot.turns[0]!.finish();
  await flush();
  void chats.send("main", "Next");
  await flush();
  expect(chats.get("main").lines.map((line) => line.text)).toEqual(["Lost"]);
  expect(chats.get("main").turn?.text).toBe("Next");
});

test("reading the conversation again waits while a turn is in flight, so the reply is not lost", async () => {
  const bot = fakeBot([{ id: "m1", role: "bot", text: "Earlier", at: "" }]);
  const chats = createBotChats(() => bot.source);
  void chats.send("main", "Hi");
  await flush();
  expect(bot.lists()).toBe(1);
  await chats.loadHistory("main");
  expect(bot.lists()).toBe(1);
  bot.turns[0]!.emit({ type: "done", messageId: "x" });
  bot.turns[0]!.finish();
  await flush();
  await chats.loadHistory("main");
  expect(bot.lists()).toBe(2);
});

test("the draft is kept per bot", () => {
  const chats = createBotChats(() => fakeBot().source);
  chats.setDraft("main", "half a thought");
  chats.setDraft("b".repeat(32), "another");
  expect(chats.draft("main")).toBe("half a thought");
  expect(chats.draft("b".repeat(32))).toBe("another");
  expect(chats.draft("c".repeat(32))).toBe("");
});

test("dispose stops every turn in flight", async () => {
  const bot = fakeBot();
  const chats = createBotChats(() => bot.source);
  void chats.send("main", "Hi");
  void chats.send("b".repeat(32), "Hi");
  await flush();
  chats.dispose();
  expect(bot.turns.every((turn) => turn.signal?.aborted)).toBe(true);
});
