import { afterEach, beforeEach, expect, test } from "bun:test";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { holdAnswer, releaseAnswer, type HeldAnswer } from "@/feed/answerOutbox";
import { AskBox } from "@/bots/AskBox";
import { CardConversation } from "@/feed/CardConversation";
import { usePendingSend } from "@/feed/cardKit";
import { OwnAnswerBox } from "@/feed/AnswerOptions";
import { RecordingTitleEditor } from "@/capture/library/rename/RecordingTitleEditor";
import { CANONICAL_ORIGIN, countLocalOnlyRecordingWork, isOriginMoveDeferred, moveWhenClear } from "@/lib/originMove";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { MemoryPanel } from "@/components/MemoryPanel";
import { installDom } from "@/test/dom";
import { installFakeClock, type FakeClock } from "@/test/fakeClock.fixture";

// A held tinycloud.chat page moves to tinycloud.one only when nothing is left that exists only in this page: typed
// words, an unsaved title, and an answer still inside its 5 s undo window (originMove.ts `deferOriginMove`).

let restore: (() => void) | undefined;
let clock: FakeClock | undefined;
const roots = new Set<Root>();
beforeEach(() => { restore = installDom(); clock = installFakeClock(); });
afterEach(async () => {
  for (const root of roots) await act(async () => root.unmount());
  roots.clear();
  clock?.restore(); clock = undefined;
  restore?.(); restore = undefined;
});

async function mount(element: React.ReactElement) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.add(root);
  await act(async () => root.render(element));
  return { host, unmount: async () => { await act(async () => root.unmount()); roots.delete(root); } };
}
async function type(node: HTMLTextAreaElement | HTMLInputElement, value: string) {
  // happy-dom has no native `input` support, so React reads a change on the focused field's key events (or an input handler).
  await act(async () => { node.focus(); });
  Object.getOwnPropertyDescriptor(node.constructor.prototype, "value")!.set!.call(node, value);
  await act(async () => {
    node.dispatchEvent(new window.Event("input", { bubbles: true }));
    node.dispatchEvent(new KeyboardEvent("keyup", { key: "a", bubbles: true }));
  });
}
const field = (host: ParentNode) => host.querySelector<HTMLTextAreaElement | HTMLInputElement>("textarea, input")!;

test("words typed in the Ask box keep a held page here until they are sent or cleared", async () => {
  const view = await mount(<AskBox working={false} onSend={() => {}} onOpenMain={() => {}} />);
  expect(isOriginMoveDeferred()).toBe(false);
  await type(field(view.host), "Plan the trip");
  expect(isOriginMoveDeferred()).toBe(true);
  await type(field(view.host), "   ");
  expect(isOriginMoveDeferred()).toBe(false);
});

test("a recording title changed and not yet saved keeps a held page here, an unchanged one does not", async () => {
  const view = await mount(<RecordingTitleEditor initial="Standup" onSave={() => {}} onCancel={() => {}} />);
  expect(isOriginMoveDeferred()).toBe(false);
  await type(field(view.host), "Standup, notes");
  expect(isOriginMoveDeferred()).toBe(true);
  await type(field(view.host), "Standup");
  expect(isOriginMoveDeferred()).toBe(false);
  await type(field(view.host), "Renamed");
  expect(isOriginMoveDeferred()).toBe(true);
  await view.unmount();
  expect(isOriginMoveDeferred()).toBe(false);
});

test("a card's comment box keeps a held page here while it holds words", async () => {
  const view = await mount(<CardConversation lines={[]} to="Agent" composer={{ open: true, onOpenChange: () => {} }} onSend={async () => true} />);
  expect(isOriginMoveDeferred()).toBe(false);
  await type(view.host.querySelector<HTMLTextAreaElement>("textarea")!, "One more thing");
  expect(isOriginMoveDeferred()).toBe(true);
  await view.unmount();
  expect(isOriginMoveDeferred()).toBe(false);
});

function OwnAnswer() {
  const [text, setText] = useState("");
  return <OwnAnswerBox text={text} disabled={false} onText={setText} onSend={() => {}} />;
}
test("words in a card's Your own answer box keep a held page here until they are cleared", async () => {
  const view = await mount(<OwnAnswer />);
  expect(isOriginMoveDeferred()).toBe(false);
  await type(field(view.host), "Not this one");
  expect(isOriginMoveDeferred()).toBe(true);
  await type(field(view.host), "");
  expect(isOriginMoveDeferred()).toBe(false);
});

test("the memory panel keeps a held page here while its edits are unsaved", async () => {
  // The panel reads its saved text from the ref; a space that cannot be read changes nothing here.
  const view = await mount(<MemoryPanel tcw={{} as TinyCloudWeb} memoryRef={{ current: "Likes tea" }} />);
  expect(isOriginMoveDeferred()).toBe(false);
  await type(view.host.querySelector<HTMLTextAreaElement>("textarea")!, "Likes tea and coffee");
  expect(isOriginMoveDeferred()).toBe(true);
  await type(view.host.querySelector<HTMLTextAreaElement>("textarea")!, "Likes tea");
  expect(isOriginMoveDeferred()).toBe(false);
});

// The feed's answer path (feedStore.saveResponse): held in this origin's outbox before its first await.
const answer = (): HeldAnswer => ({ version: 2, sourceId: "agent-one", cardId: "card-one", revision: 1, issuanceId: "issuance-one", responseId: "response-one", text: "Yes", at: new Date().toISOString() });
const outboxKeys = () => Object.keys(window.localStorage).filter((key) => key.startsWith("tinychat.home.answer-outbox.v1:"));

function Answering() {
  const [wrote, setWrote] = useState(false);
  const send = usePendingSend({ stale: false, onRefused: () => {} });
  return <button type="button" data-wrote={wrote} onClick={() => send.start("Yes", () => { holdAnswer("space-one", answer()); setWrote(true); })}>Yes</button>;
}
const settle = async () => { for (let i = 0; i < 12; i++) await act(async () => { await Promise.resolve(); }); };

test("an answer inside its undo window keeps a held page here; once sent it is held, and nothing is written to this origin after the move", async () => {
  const globalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, writable: true, value: window.localStorage });
  try {
    const view = await mount(<Answering />);
    await act(async () => view.host.querySelector("button")!.click());
    const replaced: string[] = [];
    // The browser fires pagehide as the page goes (the card flushes its waiting answer on it).
    const location = { hostname: "tinycloud.chat", pathname: "/chat", search: "", hash: "", replace: (url: string) => { replaced.push(url); window.dispatchEvent(new Event("pagehide")); } };
    const stop = moveWhenClear({
      location, window, document, opener: false, canonicalReady: async () => true, upload: () => null,
      countWork: () => countLocalOnlyRecordingWork({ factory: null, storage: window.localStorage }),
    });
    await settle();
    expect(replaced).toEqual([]);
    expect(outboxKeys()).toEqual([]);

    // The 5 s pass: the answer is sent, and written into the outbox first. That keeps the page here.
    await clock!.advance(5000);
    await settle();
    expect(outboxKeys()).toHaveLength(1);
    expect(replaced).toEqual([]);

    // The write landed and released it: now the page moves, and the page-close flush has nothing left to write.
    releaseAnswer("space-one", answer());
    window.dispatchEvent(new Event("online"));
    await settle();
    expect(replaced).toEqual([`${CANONICAL_ORIGIN}/chat`]);
    expect(outboxKeys()).toEqual([]);
    stop();
  } finally {
    if (globalStorage) Object.defineProperty(globalThis, "localStorage", globalStorage); else delete (globalThis as Record<string, unknown>).localStorage;
  }
});
