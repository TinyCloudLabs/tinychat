// Main's chat as Home holds it: the earlier messages, then the turn in flight (the owner's message and
// Main's reply as it streams). One turn at a time, as the bots service allows. Closing the chat keeps
// the turn going. With a scope, leaving Home keeps it too: the chat is the account's (mainChatStore.ts),
// not the view's; without one it is the view's own and stops when the view goes.
import { useCallback, useEffect, useRef, useState } from "react";

import { BotsError, BotsNoReply, type AppDecision, type BotMessage, type BotStep, type BotsApi, type SecretLine } from "./botsApi";
import type { BotsErrorCode } from "./botsStrings";
import { isDeclinedReply } from "./askText";
import { clearHistoryDecline, isHistoryDeclined } from "./historyAuthorization";
import { createMainChatStore, endVisitIfLeft, mainChatFor, mountedView, setMainChat, stopMainChat, type MainChatCallbacks } from "./mainChatStore";
import type { ReadArea } from "./trustbotReadAreas";
import type { WorkingStep } from "./workingStep";

/**
 * The app's report of the owner's decision on a request or proposal card. A secret request's report names the secret
 * for the chat line; a proposal's names the recipients the card showed. Neither is sent.
 */
export interface AppReply {
  requestId: string;
  decision: AppDecision;
  secret?: SecretLine;
  names?: string[];
}

/**
 * `app` marks a line the app sent for the owner (a decision on a request or proposal card), which the owner did not type.
 * `areas`, on a reply a turn in this page ended with, are the read areas that turn tried; in memory only, never on a
 * line read from history.
 */
export type ChatLine = Pick<BotMessage, "id" | "role" | "text" | "unreadableHistory"> & { app?: AppDecision; secret?: SecretLine; names?: string[]; areas?: ReadArea[] };

/** The read area behind each step that reads the owner's data. */
const STEP_AREAS: Partial<Record<BotStep, ReadArea>> = { meetings: "meetings", feed: "feed_chats", chats: "feed_chats", telegram: "telegram" };

const withoutAreas = (line: ChatLine, keep: (area: ReadArea) => boolean = () => false): ChatLine => {
  const areas = line.areas?.filter(keep) ?? [];
  const { areas: _, ...rest } = line;
  return areas.length ? { ...rest, areas } : rest;
};

/** What a line the app sent for this decision carries. */
const appMark = (reply: AppReply | undefined) => reply
  ? { app: reply.decision, ...(reply.secret ? { secret: reply.secret } : {}), ...(reply.names ? { names: reply.names } : {}) }
  : {};

export interface MainTurn {
  text: string;
  reply: string;
  state: "starting" | "working" | "error";
  error?: BotsErrorCode;
  /** What the bot is doing, for the working line. Absent until the service or the reply text says. */
  step?: WorkingStep;
  /** Set when the turn reports a decision on a question card; `text` is then empty. */
  appReply?: AppReply;
}

export interface MainChatState {
  lines: ChatLine[];
  history: "idle" | "loading" | "loaded" | "failed" | "declined";
  turn: MainTurn | null;
}

export const isWorking = (turn: MainTurn | null): boolean => !!turn && turn.state !== "error";

/** What the console keeps of a failure: never the object itself, which may carry a session or delegation. */
function errorFields(value: unknown): Record<string, unknown> {
  if (!(value instanceof Error)) return { type: typeof value };
  const code = "code" in value && (typeof value.code === "string" || typeof value.code === "number") ? value.code : undefined;
  return { name: value.name, message: value.message, code, stack: value.stack };
}

/** Which kept chat a view joins: the bots client it talks through, and the signed-in account and space. */
export interface MainChatScope {
  owner: object;
  account: string;
}

export function useMainChat(api: BotsApi, prepare?: () => Promise<void>, onNoReply?: () => void, manualHistory = false, scope?: MainChatScope) {
  const view = useRef<MainChatCallbacks>({});
  view.current = { prepare, onNoReply };
  const [own] = useState(createMainChatStore);
  const store = scope ? mainChatFor(scope.owner, scope.account) : own;
  const kept = !!scope;
  // Plain state, not useSyncExternalStore: the store's changes render batched, as the chat's own state did before.
  // Another store (another account) shows its own state at once, never the last one's.
  const [seen, setSeen] = useState(() => ({ store, state: store.state }));
  const state = seen.store === store ? seen.state : store.state;
  const setState = useCallback((update: (current: MainChatState) => MainChatState) => setMainChat(store, update), [store]);

  useEffect(() => {
    // Changes made between this view's render and now (a turn that ran on while it mounted) show at once.
    const sync = () => setSeen((current) => current.store === store && current.state === store.state ? current : { store, state: store.state });
    sync();
    return store.subscribe(sync);
  }, [store]);

  useEffect(() => {
    store.consumers.add(view);
    // A view's own chat starts with each mount (StrictMode's second one too) and stops with it, stream and all.
    if (!kept) store.lifetime = new AbortController();
    return () => {
      store.consumers.delete(view);
      if (!kept) stopMainChat(store);
      else endVisitIfLeft(store);
    };
  }, [store, kept]);

  /** A slow history read must not erase turns completed while it was in flight. */
  const loadHistory = useCallback((): Promise<void> => {
    if (store.disposed || store.lifetime.signal.aborted) return Promise.resolve();
    if (store.historyPending) return store.history ?? Promise.resolve();
    store.historyPending = true;
    const signal = store.lifetime.signal;
    const generation = store.cleared;
    const run = (async () => {
      setState((current) => ({ ...current, history: "loading" }));
      try {
        const messages = await api.listMainMessages(signal);
        setState((current) => {
          if (generation !== store.cleared) return current;
          const listed = messages.map(({ id, role, text, origin, decision, secret, unreadableHistory }): ChatLine => ({
            id, role, text,
            ...(unreadableHistory ? { unreadableHistory } : {}),
            // The service says what was decided; the words of its message are only a fallback for a service that does not.
            ...(origin === "app" ? { app: decision ?? (isDeclinedReply(text) ? "declined" as const : "answered" as const), ...(secret ? { secret } : {}) } : {}),
          }));
          const ids = new Set(listed.map(line => line.id));
          const pending: ChatLine[] = [];
          for (let i = 0; i < current.lines.length; i++) {
            const line = current.lines[i]!;
            if (!line.id.startsWith("local-")) continue;
            const reply = current.lines[i + 1]?.role === "bot" ? current.lines[++i] : undefined;
            if (reply && ids.has(reply.id)) continue;
            pending.push(line);
            if (reply) pending.push(reply);
          }
          return { ...current, history: "loaded", lines: [...listed, ...pending] };
        });
      } catch (cause) {
        if (signal.aborted) return;
        // The failure view says only that it failed; the console keeps why, for support. Details: TC-3019
        console.warn("[bots] Main's earlier messages did not load", {
          ...errorFields(cause),
          cause: cause instanceof Error && cause.cause !== undefined ? errorFields(cause.cause) : undefined,
        });
        setState((current) => (generation !== store.cleared ? current : {
          ...current,
          history: isHistoryDeclined(cause) ? "declined" : "failed",
        }));
      } finally {
        store.historyPending = false;
      }
    })();
    store.history = run;
    return run;
  }, [api, store, setState]);

  const ensureHistory = useCallback(() => manualHistory ? Promise.resolve() : store.history ?? loadHistory(), [loadHistory, manualHistory, store]);
  const requestHistory = useCallback(() => {
    if (store.disposed || store.lifetime.signal.aborted) return Promise.resolve();
    if (store.historyPending) return store.history ?? Promise.resolve();
    clearHistoryDecline();
    return loadHistory();
  }, [loadHistory, store]);

  /** After the owner starts a new chat: the earlier lines leave the view. Saved history is read again on the next visit. */
  const clear = useCallback(() => {
    store.cleared += 1;
    store.history = Promise.resolve();
    store.newChat = true;
    setState((current) => ({ ...current, lines: [], history: "loaded" }));
    // A new chat whose request outlived every view already belongs to the next visit.
    if (kept) endVisitIfLeft(store);
  }, [store, setState, kept]);

  const run = useCallback(async (text: string, keepFailed: boolean, appReply?: AppReply) => {
    if (store.disposed || store.lifetime.signal.aborted || store.turnController) return;
    const controller = new AbortController();
    store.turnController = controller;
    const setTurn = (update: (turn: MainTurn) => MainTurn) =>
      setState((current) => (current.turn ? { ...current, turn: update(current.turn) } : current));
    setState((current) => {
      const failed = keepFailed && current.turn?.state === "error"
        ? [{ id: `local-${++store.localId}`, role: "user" as const, text: current.turn.text, ...appMark(current.turn.appReply) }]
        : [];
      return { ...current, lines: [...current.lines, ...failed], turn: { text, reply: "", state: "starting", ...(appReply ? { appReply } : {}) } };
    });
    try {
      await (manualHistory ? undefined : mountedView(store)?.prepare?.());
      void ensureHistory();
      if (controller.signal.aborted) return;
      let reply = "";
      const areas: ReadArea[] = [];
      await api.sendToMain(text, (event) => {
        if (event.type === "status") setTurn((turn) => ({ ...turn, state: event.state }));
        else if (event.type === "delta") {
          reply += event.text;
          setTurn((turn) => ({ ...turn, state: "working", reply, step: { step: "writing" } }));
        } else if (event.type === "step") {
          const area = STEP_AREAS[event.step];
          if (area && !areas.includes(area)) areas.push(area);
          setTurn((turn) => ({ ...turn, step: { step: event.step, ...(event.host ? { host: event.host } : {}) } }));
        } else if (event.type === "done") {
          setState((current) => ({
            ...current,
            lines: current.lines.some(line => line.id === event.messageId) ? current.lines
              : [...current.lines, { id: `local-${++store.localId}`, role: "user", text, ...appMark(appReply) }, { id: event.messageId, role: "bot", text: reply, ...(areas.length ? { areas: [...areas] } : {}) }],
            turn: null,
          }));
        } else if (event.type === "error") setTurn((turn) => ({ ...turn, state: "error", error: event.code }));
      }, controller.signal, appReply ? { appReply: { requestId: appReply.requestId } } : undefined);
    } catch (cause) {
      if (controller.signal.aborted) return;
      if (cause instanceof BotsNoReply) {
        // Nothing was left to send for that request (another tab sent it): no error to show, only a fresh read of the requests.
        setState((current) => ({ ...current, turn: null }));
        mountedView(store)?.onNoReply?.();
      } else setTurn((turn) => ({ ...turn, state: "error", error: cause instanceof BotsError ? cause.code : isHistoryDeclined(cause) ? "history_declined" : "failed" }));
    } finally {
      if (store.turnController === controller) store.turnController = null;
      // A decision the owner made while a turn was running goes out as soon as that turn ends.
      if (!controller.signal.aborted) store.queued.shift()?.();
    }
  }, [api, ensureHistory, manualHistory, store, setState]);

  const send = useCallback((text: string) => run(text, true), [run]);
  const retry = useCallback(() => {
    if (state.turn?.state === "error") void run(state.turn.text, false, state.turn.appReply);
  }, [run, state.turn]);
  /** Tells Main what the owner decided on a question card; the service composes the words, none go from here. */
  const sendAppReply = useCallback((reply: AppReply) => {
    if (store.turnController) store.queued.push(() => void run("", true, reply));
    else void run("", true, reply);
  }, [run, store]);

  /** "Not now" on the access card for `area` under a reply: that card goes, for this page session. */
  const notNow = useCallback((lineId: string, area: ReadArea) => {
    setState((current) => current.lines.some((line) => line.id === lineId && line.areas?.includes(area))
      ? { ...current, lines: current.lines.map((line) => line.id === lineId ? withoutAreas(line, (other) => other !== area) : line) }
      : current);
  }, [setState]);

  /**
   * The owner gave access from a card under the reply `lineId`: the question before it goes again as a new turn, once.
   * Only while that reply is still the newest line and no turn runs; its cards go first, so it never goes twice.
   */
  const askAgain = useCallback((lineId: string) => {
    const { lines, turn } = store.state;
    const line = lines.at(-1);
    if (store.disposed || store.turnController || turn || line?.id !== lineId || line.role !== "bot" || !line.areas?.length) return;
    setState((current) => ({ ...current, lines: current.lines.map((other) => other.id === lineId ? withoutAreas(other) : other) }));
    const question = lines.at(-2);
    if (question?.role === "user" && !question.app && !question.unreadableHistory && question.text) void run(question.text, true);
  }, [store, setState, run]);

  return { state, send, retry, sendAppReply, ensureHistory, loadHistory, requestHistory, clear, notNow, askAgain };
}
