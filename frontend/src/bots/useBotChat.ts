// The bot view's conversations (TC-3325), one per bot, held above the view: each keeps its earlier messages, its
// turn in flight and its draft while another bot is on screen, so switching bots never stops a turn. The turn logic
// is Main's chat's (useMainChat.ts): one turn at a time per bot, as the bots service allows.
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { BotsError, type BotActivity, type BotMessage, type MainEvent } from "./botsApi";
import { isHistoryDeclined } from "./historyAuthorization";
import type { ChatLine, MainChatState, MainTurn } from "./useMainChat";

/** How the view reaches one bot. */
export interface BotChatSource {
  list(signal?: AbortSignal): Promise<BotMessage[]>;
  /** The same read as `list`, with the activity records. When present it is used in place of `list`. */
  listConversation?(signal?: AbortSignal): Promise<{ messages: BotMessage[]; activity: BotActivity[] }>;
  send(text: string, onEvent: (event: MainEvent) => void, signal?: AbortSignal): Promise<void>;
  /** Runs before each send, ahead of the earlier messages (the history permission, for instance). */
  prepare?(): Promise<void>;
}

export interface BotChatState extends MainChatState {
  /** A reply arrived while another bot was on screen. */
  unseen: boolean;
}

/** An activity line, and where it sits among the messages. */
export interface ActivityItem extends BotActivity {
  /** The id of the message line it follows; null: before the first. */
  after: string | null;
  /** Came during the turn in flight: it shows after that turn's message, and is placed when the turn ends. */
  inTurn: boolean;
}

export interface BotChats {
  get(key: string): BotChatState;
  subscribe(listener: () => void): () => void;
  /** Loads the earlier messages once; later calls wait for that load. */
  ensureHistory(key: string): Promise<void>;
  /** Loads the earlier messages again, unless a turn is in flight (its reply is not in them yet). */
  loadHistory(key: string): Promise<void>;
  send(key: string, text: string): Promise<void>;
  /** Sends a failed turn's message again. */
  retry(key: string): void;
  /** The bot on screen, or null; its `unseen` clears. */
  view(key: string | null): void;
  draft(key: string): string;
  setDraft(key: string, text: string): void;
  /** The bot's activity lines, as a stable list: it changes only when a line comes or the history is read again. */
  activity(key: string): readonly ActivityItem[];
  /** Stops every turn and load; nothing changes after it. */
  dispose(): void;
}

interface Entry {
  state: BotChatState;
  history: Promise<void> | null;
  turn: AbortController | null;
  draft: string;
  activity: ActivityItem[];
}

const EMPTY: BotChatState = { lines: [], history: "idle", turn: null, unseen: false };
const NO_ACTIVITY: ActivityItem[] = [];

/** What the console keeps of a failure: never the object itself, which may carry a session or delegation. */
function errorFields(value: unknown): Record<string, unknown> {
  if (!(value instanceof Error)) return { type: typeof value };
  const code = "code" in value && (typeof value.code === "string" || typeof value.code === "number") ? value.code : undefined;
  return { name: value.name, message: value.message, code, stack: value.stack };
}

/**
 * The activity lines of a loaded conversation, each placed after the last message sent at or before it. A message with
 * no usable time is not a place; a record with none before it comes first. The same record twice is one line.
 */
export function anchorActivity(messages: readonly BotMessage[], records: readonly BotActivity[]): ActivityItem[] {
  const stamps = messages.map((message) => Date.parse(message.at));
  const seen = new Set<string>();
  return records
    .filter((record) => !seen.has(record.id) && seen.add(record.id))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
    .map((record) => {
      const time = Date.parse(record.at);
      let after: string | null = null;
      let latest = -Infinity;
      messages.forEach((message, index) => {
        const stamp = stamps[index]!;
        if (Number.isFinite(stamp) && stamp <= time && stamp >= latest) {
          latest = stamp;
          after = message.id;
        }
      });
      return { ...record, after, inTurn: false };
    });
}

export function createBotChats(sourceFor: (key: string) => BotChatSource): BotChats {
  const entries = new Map<string, Entry>();
  const listeners = new Set<() => void>();
  const lifetime = new AbortController();
  let viewing: string | null = null;
  let localId = 0;

  const entry = (key: string): Entry => {
    let found = entries.get(key);
    if (!found) {
      found = { state: EMPTY, history: null, turn: null, draft: "", activity: NO_ACTIVITY };
      entries.set(key, found);
    }
    return found;
  };
  const update = (key: string, change: (state: BotChatState) => BotChatState) => {
    if (lifetime.signal.aborted) return;
    const target = entry(key);
    const next = change(target.state);
    if (next === target.state) return;
    target.state = next;
    for (const listener of listeners) listener();
  };
  const setTurn = (key: string, change: (turn: MainTurn) => MainTurn) =>
    update(key, (state) => (state.turn ? { ...state, turn: change(state.turn) } : state));
  const setActivity = (key: string, next: ActivityItem[]) => {
    if (lifetime.signal.aborted) return;
    entry(key).activity = next;
    for (const listener of listeners) listener();
  };
  /** The lines of the turn that just ended (or failed and was sent on) belong after its message. */
  const settleActivity = (key: string, userId: string) => {
    const known = entry(key).activity;
    if (known.some((item) => item.inTurn)) setActivity(key, known.map((item) => (item.inTurn ? { ...item, after: userId, inTurn: false } : item)));
  };

  const loadHistory = (key: string): Promise<void> => {
    const target = entry(key);
    const signal = lifetime.signal;
    const run = (async () => {
      update(key, (state) => ({ ...state, history: "loading" }));
      try {
        const source = sourceFor(key);
        const { messages, activity } = source.listConversation
          ? await source.listConversation(signal)
          : { messages: await source.list(signal), activity: [] };
        update(key, (state) => ({ ...state, history: "loaded", lines: messages.map(({ id, role, text, unreadableHistory }): ChatLine => ({ id, role, text, ...(unreadableHistory ? { unreadableHistory } : {}) })) }));
        setActivity(key, anchorActivity(messages, activity));
      } catch (cause) {
        if (signal.aborted) return;
        // The failure row says only that it failed; the console keeps why, for support.
        console.warn("[bots] a bot's earlier messages did not load", {
          ...errorFields(cause),
          cause: cause instanceof Error && cause.cause !== undefined ? errorFields(cause.cause) : undefined,
        });
        update(key, (state) => ({ ...state, history: isHistoryDeclined(cause) ? "declined" : "failed" }));
      }
    })();
    target.history = run;
    return run;
  };
  const ensureHistory = (key: string) => entry(key).history ?? loadHistory(key);

  const run = async (key: string, text: string, keepFailed: boolean) => {
    const target = entry(key);
    if (target.turn || lifetime.signal.aborted) return;
    const controller = new AbortController();
    target.turn = controller;
    const stop = () => controller.abort();
    lifetime.signal.addEventListener("abort", stop, { once: true });
    const failed = keepFailed && target.state.turn?.state === "error"
      ? { id: `local-${++localId}`, role: "user" as const, text: target.state.turn.text }
      : null;
    update(key, (state) => ({ ...state, lines: failed ? [...state.lines, failed] : state.lines, turn: { text, reply: "", state: "starting" } }));
    if (failed) settleActivity(key, failed.id);
    try {
      const source = sourceFor(key);
      // The earlier messages load first, so the new one is never listed twice.
      await source.prepare?.();
      await ensureHistory(key);
      if (controller.signal.aborted) return;
      let reply = "";
      await source.send(text, (event) => {
        if (event.type === "status") setTurn(key, (turn) => ({ ...turn, state: event.state }));
        else if (event.type === "delta") {
          reply += event.text;
          setTurn(key, (turn) => ({ ...turn, state: "working", reply, step: { step: "writing" } }));
        } else if (event.type === "step") {
          setTurn(key, (turn) => ({ ...turn, step: { step: event.step, ...(event.host ? { host: event.host } : {}) } }));
        } else if (event.type === "activity") {
          const known = entry(key).activity;
          if (!known.some((item) => item.id === event.activity.id)) setActivity(key, [...known, { ...event.activity, after: null, inTurn: true }]);
        } else if (event.type === "done") {
          const userId = `local-${++localId}`;
          update(key, (state) => ({
            ...state,
            lines: [...state.lines, { id: userId, role: "user", text }, { id: event.messageId, role: "bot", text: reply }],
            turn: null,
            unseen: state.unseen || viewing !== key,
          }));
          settleActivity(key, userId);
        } else setTurn(key, (turn) => ({ ...turn, state: "error", error: event.code }));
      }, controller.signal);
    } catch (cause) {
      if (controller.signal.aborted) return;
      setTurn(key, (turn) => ({ ...turn, state: "error", error: cause instanceof BotsError ? cause.code : isHistoryDeclined(cause) ? "history_declined" : "failed" }));
    } finally {
      lifetime.signal.removeEventListener("abort", stop);
      if (target.turn === controller) target.turn = null;
    }
  };

  return {
    get: (key) => entries.get(key)?.state ?? EMPTY,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    ensureHistory,
    loadHistory: (key) => (entry(key).turn ? ensureHistory(key) : loadHistory(key)),
    send: (key, text) => run(key, text, true),
    activity: (key) => entries.get(key)?.activity ?? NO_ACTIVITY,
    retry(key) {
      const turn = entries.get(key)?.state.turn;
      if (turn?.state === "error") void run(key, turn.text, false);
    },
    view(key) {
      viewing = key;
      if (key !== null) update(key, (state) => (state.unseen ? { ...state, unseen: false } : state));
    },
    draft: (key) => entries.get(key)?.draft ?? "",
    setDraft(key, text) {
      entry(key).draft = text;
    },
    dispose() {
      lifetime.abort();
      listeners.clear();
    },
  };
}

/**
 * One set of conversations for as long as the caller is mounted (null for the first render). It is made in an
 * effect, so StrictMode's second mount gets a live one. `sourceFor` is read at call time.
 */
export function useBotChats(sourceFor: (key: string) => BotChatSource): BotChats | null {
  const latest = useRef(sourceFor);
  latest.current = sourceFor;
  const [chats, setChats] = useState<BotChats | null>(null);
  useEffect(() => {
    const created = createBotChats((key) => latest.current(key));
    setChats(created);
    return () => created.dispose();
  }, []);
  return chats;
}

export function useBotChat(chats: BotChats, key: string): BotChatState {
  return useSyncExternalStore(chats.subscribe, () => chats.get(key), () => chats.get(key));
}

export function useBotActivity(chats: BotChats, key: string): readonly ActivityItem[] {
  return useSyncExternalStore(chats.subscribe, () => chats.activity(key), () => chats.activity(key));
}
