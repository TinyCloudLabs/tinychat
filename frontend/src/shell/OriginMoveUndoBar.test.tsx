import { afterEach, beforeEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { holdAnswer, releaseAnswer, type HeldAnswer } from "@/feed/answerOutbox";
import { SendPills } from "@/feed/SendPills";
import { useUndoBar } from "@/feed/UndoBar";
import { CANONICAL_ORIGIN, countLocalOnlyRecordingWork, isOriginMoveDeferred, moveWhenClear } from "@/lib/originMove";
import { installDom } from "@/test/dom";
import { installFakeClock, type FakeClock } from "@/test/fakeClock.fixture";

// A held tinycloud.chat page moves to tinycloud.one only when nothing is left that exists only in this page. An Undo-bar
// action (Drop, Acknowledge, Ask me later, Show me later) counts 5 s in memory and then writes its owner action into
// this origin's answer outbox; that write must not land after the move has cleared the outbox.

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

const dropped = (): HeldAnswer => ({ version: 2, sourceId: "agent-one", cardId: "card-one", revision: 1, issuanceId: "issuance-one", responseId: "action-one", ownerAction: { type: "feed.drop" }, at: new Date().toISOString() });
const outboxKeys = () => Object.keys(window.localStorage).filter((key) => key.startsWith("tinychat.home.answer-outbox.v1:"));
const settle = async () => { for (let i = 0; i < 12; i++) await act(async () => { await Promise.resolve(); }); };

/** A card taken away through the real Undo bar; its commit holds the owner action in the outbox first, as the feed's send does. */
function Dropping() {
  const bar = useUndoBar(() => {});
  return <>
    <button type="button" data-drop onClick={() => bar.push({ key: "card-one", text: "Dropped", commit: async () => { holdAnswer("space-one", dropped()); } })}>Drop</button>
    <SendPills items={bar.pills} />
  </>;
}

async function mountDropping() {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.add(root);
  await act(async () => root.render(<Dropping />));
  await act(async () => host.querySelector<HTMLButtonElement>("[data-drop]")!.click());
  return host;
}
function startMove() {
  const replaced: string[] = [];
  // The browser fires pagehide as the page goes; the Undo bar flushes what is waiting on it.
  const location = { hostname: "tinycloud.chat", pathname: "/chat", search: "", hash: "", replace: (url: string) => { replaced.push(url); window.dispatchEvent(new Event("pagehide")); } };
  const stop = moveWhenClear({
    location, window, document, opener: false, canonicalReady: async () => true, upload: () => null,
    countWork: () => countLocalOnlyRecordingWork({ factory: null, storage: window.localStorage }),
  });
  return { replaced, stop };
}
async function withStorage(run: () => Promise<void>) {
  const globalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, writable: true, value: window.localStorage });
  try { await run(); } finally { if (globalStorage) Object.defineProperty(globalThis, "localStorage", globalStorage); else delete (globalThis as Record<string, unknown>).localStorage; }
}

test("an Undo-bar action keeps a held page here while it counts; once sent it is held, and nothing is written to this origin after the move", async () => {
  await withStorage(async () => {
    await mountDropping();
    expect(isOriginMoveDeferred()).toBe(true);
    const { replaced, stop } = startMove();
    await settle();
    expect(replaced).toEqual([]);
    expect(outboxKeys()).toEqual([]);

    // The 5 s pass: the action is sent, and written into the outbox first. That keeps the page here.
    await clock!.advance(5000);
    await settle();
    expect(outboxKeys()).toHaveLength(1);
    expect(replaced).toEqual([]);

    // The write landed and released it: now the page moves, and the page-close flush has nothing left to write.
    releaseAnswer("space-one", dropped());
    window.dispatchEvent(new Event("online"));
    await settle();
    expect(replaced).toEqual([`${CANONICAL_ORIGIN}/chat`]);
    expect(outboxKeys()).toEqual([]);
    stop();
  });
});

test("an Undo-bar action undone inside its window writes nothing, and the page then moves", async () => {
  await withStorage(async () => {
    const host = await mountDropping();
    const { replaced, stop } = startMove();
    await settle();
    expect(replaced).toEqual([]);
    const undo = [...host.querySelectorAll("button")].find((node) => node.textContent === "Undo")!;
    await act(async () => undo.click());
    window.dispatchEvent(new Event("online"));
    await settle();
    expect(replaced).toEqual([`${CANONICAL_ORIGIN}/chat`]);
    expect(outboxKeys()).toEqual([]);
    stop();
  });
});

test("hiding the page while an Undo-bar action counts sends it at once, written to this origin's outbox first, and the action no longer holds the page", async () => {
  await withStorage(async () => {
    await mountDropping();
    expect(isOriginMoveDeferred()).toBe(true);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    try {
      document.dispatchEvent(new Event("visibilitychange"));
      await settle();
      expect(outboxKeys()).toHaveLength(1);
      expect(isOriginMoveDeferred()).toBe(false);
    } finally { delete (document as unknown as Record<string, unknown>).visibilityState; }
  });
});
