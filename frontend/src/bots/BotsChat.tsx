// The Bots chat view in the Chat slot (TC-3325): the bot view for the bot picked, with each bot's conversation kept
// while another is on screen. Main is always there, so an account whose list of bots has not loaded (or a backend
// without that list) still has Main's chat. Saving history into the owner's space and the expiry notice work per bot,
// as they do for Main's chat over Home.
import { useCallback, useEffect, useRef, useState, type ComponentProps, type ReactNode } from "react";

import { BotAvatar, MAIN_BOT } from "./BotAvatar";
import { botChatApi as defaultChatApi, type BotChatApi } from "./botChatApi";
import type { BotMessage } from "./botsApi";
import type { CreateBotInput } from "./botRosterApi";
import type { ColourId, ShapeId } from "./botShapes";
import { BotView, type ViewBot } from "./BotView";
import type { BotManagement } from "./BotManage";
import type { HistoryNotice } from "./historyNotice";
import { useBotChats, type BotChatSource, type BotChats } from "./useBotChat";

/** One bot as the roster lists it: the part of it this view reads. */
export interface ControllerBot {
  key: string;
  name: string;
  environment: "regular" | "private";
  state: "active" | "suspended" | "deleting";
  /** The look the roster holds; Edit starts from it. */
  shape?: ShapeId;
  colour?: ColourId;
}

/** The account's bots, from the roster (useBots.ts): Main first. */
export interface BotsController<Bot extends ControllerBot = ControllerBot> {
  status: "loading" | "ready" | "failed";
  roster: { bots: readonly Bot[] } | null;
  /** Changing a bot (botRosterApi.ts), after which the roster is read again. Absent: the panel offers no Edit or Delete bot. */
  manage?: {
    update(key: string, input: Partial<CreateBotInput>): Promise<unknown>;
    remove(key: string): Promise<unknown>;
  };
}

/** Saving a bot's history into the owner's space, and reading it back. */
export interface BotHistoryAccess {
  /** False where the backend's history routes are off. */
  enabled(): Promise<boolean>;
  /** Foreground only: may ask the owner to approve, as Main's chat does on first use. */
  authorize(): Promise<void>;
  /** Hands the backend this bot's permission to save into its own directory; never asks the owner. */
  grant(key: string): Promise<void>;
  read(key: string, signal?: AbortSignal): Promise<BotMessage[]>;
}

type Face = ComponentProps<typeof BotAvatar>["bot"];

const MAIN: ControllerBot = { key: "main", name: MAIN_BOT.name, environment: "private", state: "active" };
const NOTICE_MS = 30_000;

/** The bots the view can show: the roster's, less those being deleted, with Main first even before it loads. */
export function viewableBots<Bot extends ControllerBot>(controller: BotsController<Bot>): readonly (Bot | ControllerBot)[] {
  const listed = controller.roster?.bots.filter((bot) => bot.state !== "deleting") ?? [];
  return listed.some((bot) => bot.key === "main") ? listed : [MAIN, ...listed];
}

export interface BotsChatProps<Bot extends ControllerBot> {
  controller: BotsController<Bot>;
  /** The key of the bot to show; Main when the roster does not list it. */
  selected: string;
  /** The avatar for a bot of the roster. */
  faceOf: (bot: Bot | ControllerBot) => Face;
  /** Null: nothing is saved into the owner's space (signed out, local validation). */
  history: BotHistoryAccess | null;
  /** The Chat slot is on screen. */
  active: boolean;
  onReconnect?: () => void;
  chatApi?: BotChatApi;
  /** Receives the conversations, for the navigation's rings and dots. */
  onChats?: (chats: BotChats | null) => void;
  /** Above the conversation: the other bots, on a phone. */
  strip?: ReactNode;
}

export function BotsChat<Bot extends ControllerBot>({
  controller, selected, faceOf, history, active, onReconnect, chatApi = defaultChatApi, onChats, strip,
}: BotsChatProps<Bot>) {
  const sourceFor = useCallback((key: string): BotChatSource => {
    const authorize = async () => {
      if (!history || !(await history.enabled())) return false;
      await history.authorize();
      await history.grant(key);
      return true;
    };
    const listConversation = async (signal?: AbortSignal) => {
      const local = chatApi.listConversation
        ? await chatApi.listConversation(key, signal)
        : { messages: await chatApi.listMessages(key, signal), activity: [] };
      if (!(await authorize())) return local;
      const archived = await history!.read(key, signal);
      return { ...local, messages: [...new Map([...archived, ...local.messages].map((message) => [message.id, message])).values()] };
    };
    return {
      list: async (signal) => (await listConversation(signal)).messages,
      listConversation,
      send: (text, onEvent, signal) => chatApi.send(key, text, onEvent, signal),
      prepare: async () => { await authorize(); },
    };
  }, [chatApi, history]);
  const chats = useBotChats(sourceFor);
  useEffect(() => { onChats?.(chats); }, [chats, onChats]);
  useEffect(() => () => onChats?.(null), [onChats]);

  const bots = viewableBots(controller);
  const listed = bots.find((bot) => bot.key === selected);
  const waiting = !listed && selected !== "main" && controller.status === "loading";
  const shown = listed ?? MAIN;

  // The expiry notice of the bot on screen, read again every 30 seconds while the Chat slot shows. The permission is
  // handed over first, as Main's chat over Home does, so a notice that a renewal settles goes away.
  const [notice, setNotice] = useState<{ key: string; notice: HistoryNotice | null } | null>(null);
  useEffect(() => {
    if (!active || !history || waiting) return;
    let current = true;
    const key = shown.key;
    const load = async () => {
      await history.grant(key).catch(() => {});
      const value = await chatApi.readNotice(key).catch(() => undefined);
      if (current && value !== undefined) setNotice({ key, notice: value });
    };
    void load();
    const timer = setInterval(() => void load(), NOTICE_MS);
    return () => {
      current = false;
      clearInterval(timer);
    };
  }, [active, chatApi, history, shown.key, waiting]);

  // Main's chat over Home talks to the same Main: coming back to the Chat slot reads the conversation on screen again.
  const wasActive = useRef(active);
  useEffect(() => {
    const returned = active && !wasActive.current;
    wasActive.current = active;
    if (returned && chats && chats.get(shown.key).history !== "idle") void chats.loadHistory(shown.key);
  }, [active, chats, shown.key]);

  const acknowledgeNotice = useCallback(
    (value: HistoryNotice, renderedAt: number) => chatApi.acknowledgeNotice(shown.key, value, renderedAt),
    [chatApi, shown.key],
  );

  if (!chats || waiting) return <div className="h-full bg-background" data-bot-view-loading="" />;
  const view: ViewBot = { key: shown.key, name: shown.name, private: shown.environment === "private", face: faceOf(shown) };
  const { manage: actions } = controller;
  const manage: BotManagement | undefined = actions && shown.shape && shown.colour
    ? {
      shape: shown.shape,
      colour: shown.colour,
      takenNames: bots.filter((bot) => bot.key !== shown.key).map((bot) => bot.name),
      update: (input) => actions.update(shown.key, input),
      remove: shown.key === "main" ? undefined : () => actions.remove(shown.key),
    }
    : undefined;
  return (
    <BotView
      bot={view}
      chats={chats}
      notice={notice?.key === shown.key ? notice.notice : null}
      acknowledgeNotice={acknowledgeNotice}
      onReconnect={onReconnect}
      strip={strip}
      manage={manage}
    />
  );
}
