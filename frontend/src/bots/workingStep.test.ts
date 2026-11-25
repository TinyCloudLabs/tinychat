// TC-4382: the working line names the step the app knows of in the owner's words and falls back to one generic line.
import { expect, test } from "bun:test";

import { BOT_STEPS, createMainEventParser, type BotStep, type MainEvent } from "./botsApi";
import { createBotChats } from "./useBotChat";
import { workingStepText, type WorkingStep } from "./workingStep";
import { WORKING_STRINGS } from "./workingStrings";

const LINES: Record<BotStep | "writing", string> = {
  thinking: "Working on it…",
  request: "Working on it…",
  search: "Searching the web…",
  read_page: "Reading a page…",
  writing: "Writing the reply…",
  commands: "Using its computer…",
  files: "Using its files…",
  secret: "Using a saved secret…",
  meetings: "Using your meetings…",
  feed: "Using your feed…",
  chats: "Using your chats…",
  telegram: "Using your Telegram chats…",
  bot_message: "Using another bot…",
  tool: "Using a tool…",
};

test("with no step known the line is the generic one", () => {
  expect(workingStepText(undefined)).toBe("Working on it…");
});

for (const step of [...BOT_STEPS, "writing"] as const) {
  test(`step ${step} reads "${LINES[step]}"`, () => {
    expect(workingStepText({ step })).toBe(LINES[step]);
  });
}

test("a page read names the site, without a leading www", () => {
  expect(workingStepText({ step: "read_page", host: "www.tides.example" })).toBe("Reading tides.example…");
  expect(workingStepText({ step: "read_page", host: "docs.tides.example" })).toBe("Reading docs.tides.example…");
  expect(workingStepText({ step: "read_page" })).toBe("Reading a page…");
});

test("a card waiting on the owner comes ahead of any step, and ends with no ellipsis", () => {
  for (const step of [undefined, { step: "search" }, { step: "writing" }, { step: "read_page", host: "tides.example" }] satisfies (WorkingStep | undefined)[]) {
    expect(workingStepText(step, true)).toBe("Waiting for your approval");
  }
});

test("every line is short plain text and ends in one ellipsis character unless it waits on the reader; none is the fixed line this replaces", () => {
  const lines = [WORKING_STRINGS.generic, WORKING_STRINGS.readingPage, WORKING_STRINGS.readingSite("tides.example"), ...Object.values(WORKING_STRINGS.steps)];
  for (const line of lines) {
    expect(line).toMatch(/^[A-Z][^…]*…$/);
    expect(line).not.toContain("..");
    expect(line.length).toBeLessThanOrEqual(40);
    expect(line).not.toBe("Handling it");
  }
  expect(WORKING_STRINGS.approval).not.toContain("…");
});

function parse(stream: string): MainEvent[] {
  const events: MainEvent[] = [];
  createMainEventParser((event) => events.push(event))(stream);
  return events;
}

test("the reply stream's step events are read: a known id, and a host only with a page read", () => {
  expect(parse([
    'event: step\ndata: {"step":"search"}\n\n',
    'event: step\ndata: {"step":"read_page","host":"www.tides.example"}\n\n',
    'event: step\ndata: {"step":"read_page"}\n\n',
    'event: step\ndata: {"step":"commands","host":"tides.example"}\n\n',
    'event: step\ndata: {"step":"thinking"}\n\n',
  ].join(""))).toEqual([
    { type: "step", step: "search" },
    { type: "step", step: "read_page", host: "www.tides.example" },
    { type: "step", step: "read_page" },
    { type: "step", step: "commands" },
    { type: "step", step: "thinking" },
  ]);
});

test("a step this app does not know is left out and the turn goes on; a host that is not a plain host name is dropped", () => {
  expect(parse([
    'event: step\ndata: {"step":"a_step_added_later"}\n\n',
    'event: step\ndata: {"step":7}\n\n',
    'event: step\ndata: {}\n\n',
    'event: step\ndata: {"step":"read_page","host":"Tides.Example/whitby?q=secret"}\n\n',
    'event: step\ndata: {"step":"read_page","host":"owner:pass@tides.example"}\n\n',
    'event: step\ndata: {"step":"read_page","host":"<b>tides</b>"}\n\n',
    'event: step\ndata: {"step":"read_page","host":42}\n\n',
    'event: delta\ndata: {"text":"Hello"}\n\n',
  ].join(""))).toEqual([
    { type: "step", step: "read_page" },
    { type: "step", step: "read_page" },
    { type: "step", step: "read_page" },
    { type: "step", step: "read_page" },
    { type: "delta", text: "Hello" },
  ]);
});

test("a turn follows the signals: no step, then the service's steps, then writing once reply text arrives", async () => {
  let emit!: (event: MainEvent) => void;
  const chats = createBotChats(() => ({
    list: async () => [],
    send: (_text, onEvent) => {
      emit = onEvent;
      return new Promise<void>(() => {});
    },
  }));
  const line = () => workingStepText(chats.get("main").turn?.step);
  void chats.send("main", "When is high tide?");
  await new Promise((resolve) => setTimeout(resolve, 0));
  emit({ type: "status", state: "working" });
  expect(line()).toBe("Working on it…");
  emit({ type: "delta", text: "Checking the tide tables." });
  expect(line()).toBe("Writing the reply…");
  emit({ type: "step", step: "thinking" });
  expect(line()).toBe("Working on it…");
  emit({ type: "step", step: "search" });
  expect(line()).toBe("Searching the web…");
  emit({ type: "status", state: "working" });
  expect(line()).toBe("Searching the web…");
  emit({ type: "step", step: "read_page", host: "www.tides.example" });
  expect(line()).toBe("Reading tides.example…");
  emit({ type: "delta", text: " High tide is at 14:05." });
  expect(line()).toBe("Writing the reply…");
  expect(chats.get("main").turn?.reply).toBe("Checking the tide tables. High tide is at 14:05.");
  emit({ type: "done", messageId: "m1" });
  expect(chats.get("main").turn).toBeNull();
  chats.dispose();
});
