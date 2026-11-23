// Main's chat as Home holds it: the earlier messages, then the turn in flight (the owner's message and
// Main's reply as it streams). One turn at a time, as the bots service allows. Closing the chat keeps
// the turn going; leaving Home stops it.
import { useCallback, useEffect, useRef, useState } from "react";

import { BotsError, BotsNoReply, type AppDecision, type BotMessage, type BotsApi, type SecretLine } from "./botsApi";
import type { BotsErrorCode } from "./botsStrings";
import { isDeclinedReply } from "./askText";
import { isHistoryDeclined } from "./historyAuthorization";

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

/** `app` marks a line the app sent for the owner (a decision on a request or proposal card), which the owner did not type. */
export type ChatLine = Pick<BotMessage, "id" | "role" | "text" | "unreadableHistory"> & { app?: AppDecision; secret?: SecretLine; names?: string[] };

/** What a line the app sent for this decision carries. */
const appMark = (reply: AppReply | undefined) => reply
  ? { app: reply.decision, ...(reply.secret ? { secret: reply.secret } : {}), ...(reply.names ? { names: reply.names } : {}) }
  : {};

export interface MainTurn {
  text: string;
  reply: string;
  state: "starting" | "working" | "error";
  error?: BotsErrorCode;
  /** Set when the turn reports a decision on a question card; `text` is then empty. */
  appReply?: AppReply;
}

export interface MainChatState {
  lines: ChatLine[];
  history: "idle" | "loading" | "loaded" | "failed" | "declined" | "signed_out";
  turn: MainTurn | null;
}

export const isWorking = (turn: MainTurn | null): boolean => !!turn && turn.state !== "error";

/** What the console keeps of a failure: never the object itself, which may carry a session or delegation. */
function errorFields(value: unknown): Record<string, unknown> {
  if (!(value instanceof Error)) return { type: typeof value };
  const code = "code" in value && (typeof value.code === "string" || typeof value.code === "number") ? value.code : undefined;
  return { name: value.name, message: value.message, code, stack: value.stack };
}

export function useMainChat(api: BotsApi, prepare?: () => Promise<void>, onNoReply?: () => void) {
  const noReply = useRef(onNoReply);
  noReply.current = onNoReply;
  const [state, setState] = useState<MainChatState>({ lines: [], history: "idle", turn: null });
  const lifetime = useRef<AbortController | null>(null);
  const turnController = useRef<AbortController | null>(null);
  const history = useRef<Promise<void> | null>(null);
  const localId = useRef(0);
  const queued = useRef<(() => void)[]>([]);
  // Counts the owner's new chats, so a history read that started before one never brings the earlier lines back.
  const cleared = useRef(0);

  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => {
      controller.abort();
      turnController.current?.abort();
      history.current = null;
      queued.current = [];
    };
  }, []);

  /** A slow history read must not erase turns completed while it was in flight. */
  const loadHistory = useCallback((): Promise<void> => {
    const signal = lifetime.current?.signal;
    const generation = cleared.current;
    const run = (async () => {
      setState((current) => ({ ...current, history: "loading" }));
      try {
        const messages = await api.listMainMessages(signal);
        setState((current) => {
          if (generation !== cleared.current) return current;
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
        if (signal?.aborted) return;
        // The failure view says only that it failed; the console keeps why, for support. Details: TC-3019
        console.warn("[bots] Main's earlier messages did not load", {
          ...errorFields(cause),
          cause: cause instanceof Error && cause.cause !== undefined ? errorFields(cause.cause) : undefined,
        });
        setState((current) => (generation !== cleared.current ? current : {
          ...current,
          history: isHistoryDeclined(cause) ? "declined" : cause instanceof BotsError && cause.code === "signed_out" ? "signed_out" : "failed",
        }));
      }
    })();
    history.current = run;
    return run;
  }, [api]);

  const ensureHistory = useCallback(() => history.current ?? loadHistory(), [loadHistory]);

  /** After the owner starts a new chat: the earlier lines leave the view. Saved history is read again on the next visit. */
  const clear = useCallback(() => {
    cleared.current += 1;
    history.current = Promise.resolve();
    setState((current) => ({ ...current, lines: [], history: "loaded" }));
  }, []);

  const run = useCallback(async (text: string, keepFailed: boolean, appReply?: AppReply) => {
    if (turnController.current) return;
    const controller = new AbortController();
    turnController.current = controller;
    const setTurn = (update: (turn: MainTurn) => MainTurn) =>
      setState((current) => (current.turn ? { ...current, turn: update(current.turn) } : current));
    setState((current) => {
      const failed = keepFailed && current.turn?.state === "error"
        ? [{ id: `local-${++localId.current}`, role: "user" as const, text: current.turn.text, ...appMark(current.turn.appReply) }]
        : [];
      return { ...current, lines: [...current.lines, ...failed], turn: { text, reply: "", state: "starting", ...(appReply ? { appReply } : {}) } };
    });
    try {
      // Authorization still gates sending; a slow or failed history read does not.
      await prepare?.();
      void ensureHistory();
      if (controller.signal.aborted) return;
      let reply = "";
      await api.sendToMain(text, (event) => {
        if (event.type === "status") setTurn((turn) => ({ ...turn, state: event.state }));
        else if (event.type === "delta") {
          reply += event.text;
          setTurn((turn) => ({ ...turn, state: "working", reply }));
        } else if (event.type === "done") {
          setState((current) => ({
            ...current,
            lines: current.lines.some(line => line.id === event.messageId) ? current.lines
              : [...current.lines, { id: `local-${++localId.current}`, role: "user", text, ...appMark(appReply) }, { id: event.messageId, role: "bot", text: reply }],
            turn: null,
          }));
        } else if (event.type === "error") setTurn((turn) => ({ ...turn, state: "error", error: event.code }));
      }, controller.signal, appReply ? { appReply: { requestId: appReply.requestId } } : undefined);
    } catch (cause) {
      if (controller.signal.aborted) return;
      if (cause instanceof BotsNoReply) {
        // Nothing was left to send for that request (another tab sent it): no error to show, only a fresh read of the requests.
        setState((current) => ({ ...current, turn: null }));
        noReply.current?.();
      } else setTurn((turn) => ({ ...turn, state: "error", error: cause instanceof BotsError ? cause.code : isHistoryDeclined(cause) ? "history_declined" : "failed" }));
    } finally {
      if (turnController.current === controller) turnController.current = null;
      // A decision the owner made while a turn was running goes out as soon as that turn ends.
      if (!controller.signal.aborted) queued.current.shift()?.();
    }
  }, [api, ensureHistory, prepare]);

  const send = useCallback((text: string) => run(text, true), [run]);
  const retry = useCallback(() => {
    if (state.turn?.state === "error") void run(state.turn.text, false, state.turn.appReply);
  }, [run, state.turn]);
  /** Tells Main what the owner decided on a question card; the service composes the words, none go from here. */
  const sendAppReply = useCallback((reply: AppReply) => {
    if (turnController.current) queued.current.push(() => void run("", true, reply));
    else void run("", true, reply);
  }, [run]);

  return { state, send, retry, sendAppReply, ensureHistory, loadHistory, clear };
}
