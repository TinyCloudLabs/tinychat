// Main's chat as Home holds it: the earlier messages, then the turn in flight (the owner's message and
// Main's reply as it streams). One turn at a time, as the bots service allows. Closing the chat keeps
// the turn going; leaving Home stops it.
import { useCallback, useEffect, useRef, useState } from "react";

import { BotsError, type BotMessage, type BotsApi } from "./botsApi";
import type { BotsErrorCode } from "./botsStrings";

export type ChatLine = Pick<BotMessage, "id" | "role" | "text">;

export interface MainTurn {
  text: string;
  reply: string;
  state: "starting" | "working" | "error";
  error?: BotsErrorCode;
}

export interface MainChatState {
  lines: ChatLine[];
  history: "idle" | "loading" | "loaded" | "failed";
  turn: MainTurn | null;
}

export const isWorking = (turn: MainTurn | null): boolean => !!turn && turn.state !== "error";

export function useMainChat(api: BotsApi, prepare?: () => Promise<void>) {
  const [state, setState] = useState<MainChatState>({ lines: [], history: "idle", turn: null });
  const lifetime = useRef<AbortController | null>(null);
  const turnController = useRef<AbortController | null>(null);
  const history = useRef<Promise<void> | null>(null);
  const localId = useRef(0);

  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => {
      controller.abort();
      turnController.current?.abort();
      history.current = null;
    };
  }, []);

  /** A slow history read must not erase turns completed while it was in flight. */
  const loadHistory = useCallback((): Promise<void> => {
    const signal = lifetime.current?.signal;
    const run = (async () => {
      setState((current) => ({ ...current, history: "loading" }));
      try {
        const messages = await api.listMainMessages(signal);
        setState((current) => {
          const listed = messages.map(({ id, role, text }) => ({ id, role, text }));
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
      } catch {
        if (!signal?.aborted) setState((current) => ({ ...current, history: "failed" }));
      }
    })();
    history.current = run;
    return run;
  }, [api]);

  const ensureHistory = useCallback(() => history.current ?? loadHistory(), [loadHistory]);

  const run = useCallback(async (text: string, keepFailed: boolean) => {
    if (turnController.current) return;
    const controller = new AbortController();
    turnController.current = controller;
    const setTurn = (update: (turn: MainTurn) => MainTurn) =>
      setState((current) => (current.turn ? { ...current, turn: update(current.turn) } : current));
    setState((current) => {
      const failed = keepFailed && current.turn?.state === "error"
        ? [{ id: `local-${++localId.current}`, role: "user" as const, text: current.turn.text }]
        : [];
      return { ...current, lines: [...current.lines, ...failed], turn: { text, reply: "", state: "starting" } };
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
              : [...current.lines, { id: `local-${++localId.current}`, role: "user", text }, { id: event.messageId, role: "bot", text: reply }],
            turn: null,
          }));
        } else setTurn((turn) => ({ ...turn, state: "error", error: event.code }));
      }, controller.signal);
    } catch (cause) {
      if (controller.signal.aborted) return;
      setTurn((turn) => ({ ...turn, state: "error", error: cause instanceof BotsError ? cause.code : "failed" }));
    } finally {
      if (turnController.current === controller) turnController.current = null;
    }
  }, [api, ensureHistory, prepare]);

  const send = useCallback((text: string) => run(text, true), [run]);
  const retry = useCallback(() => {
    if (state.turn?.state === "error") void run(state.turn.text, false);
  }, [run, state.turn]);

  return { state, send, retry, ensureHistory, loadHistory };
}
