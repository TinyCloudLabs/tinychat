// TC-2909: real Home/Main UI with a controllable supervisor history response; no wallet or network calls.
import { createRoot } from "react-dom/client";
import { HomeAskBox } from "../bots/HomeAskBox";
import type { BotMessage, MainEvent } from "../bots/botsApi";
import { initSizeClass } from "../lib/sizeClass";

function pendingHistory() {
  let resolve!: (messages: BotMessage[]) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<BotMessage[]>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
let history = pendingHistory();
let finish: (() => void) | undefined;
let event: ((event: MainEvent) => void) | undefined;
const probe = { reads: 0, sends: 0,
  fail: () => history.reject(new Error("history timeout")),
  resolve: () => history.resolve([{ id: "old", role: "bot", text: "Earlier answer", at: "" }]),
  complete: () => { event?.({ type: "delta", text: "Current answer" }); event?.({ type: "done", messageId: "new" }); finish?.(); },
};
Object.assign(window, { tc2909: probe });
initSizeClass();
createRoot(document.getElementById("root")!).render(<HomeAskBox api={{
  getBotsStatus: async () => ({ enabled: true }),
  listMainMessages: () => { if (probe.reads++) history = pendingHistory(); return history.promise; },
  sendToMain: async (_text, callback) => { probe.sends++; event = callback; callback({ type: "status", state: "working" }); await new Promise<void>(resolve => { finish = resolve; }); },
}} />);
