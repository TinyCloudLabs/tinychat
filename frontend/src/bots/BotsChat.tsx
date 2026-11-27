// The Bots chat view in the Chat slot (TC-3325): the bot view for the bot picked, with each bot's conversation kept
// while another is on screen. Main is always there, so an account whose list of bots has not loaded (or a backend
// without that list) still has Main's chat. Saving history into the owner's space and the expiry notice work per bot,
// as they do for Main's chat over Home.
import { useCallback, useEffect, useMemo, useRef, useState, type ComponentProps, type ReactNode } from "react";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { listThreads } from "../lib/threadStore";
import { BotAvatar, MAIN_BOT } from "./BotAvatar";
import { botChatApi as defaultChatApi, type BotChatApi } from "./botChatApi";
import type { BotMessage, BotsApi } from "./botsApi";
import type { CreateBotInput } from "./botRosterApi";
import type { ColourId, ShapeId } from "./botShapes";
import { BotView, type MainBotControls, type ViewBot } from "./BotView";
import type { BotManagement } from "./BotManage";
import { MAIN_BOT_OLD_NAME } from "./botsStrings";
import { readDeniedChatIds, setChatDenied } from "./chatReadAccessApi";
import type { HistoryNotice } from "./historyNotice";
import type { EarlierHistoryMove } from "./earlierHistory";
import { mainBotBridgeStore, takePendingMainSend } from "./mainBotBridge";
import { newMainChat } from "./mainNewChat";
import { listTelegramChats } from "./telegramChatReadAccess";
import { ensureTrustBotReadGrant, readSettings, revokeReadGrant, setReadArea, signReadGrant } from "./trustbotReadGrant";
import { useAsks, type AsksApi } from "./useAsks";
import { useBotChat, useBotChats, type BotChatSource, type BotChats } from "./useBotChat";
import { isWorking } from "./useMainChat";

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
  /** Whether this bot's history is saved at all; omitted means every bot's is. A bot that saves none is never authorised, granted, read or asked for a notice. */
  saves?(key: string): boolean;
  read(key: string, signal?: AbortSignal): Promise<BotMessage[]>;
  /** Asks the owner for the network-wide decrypt that opens earlier (v1) history; true when approved. Only the "Move earlier history" action calls it. Omitted: earlier history cannot be moved from here. */
  requestEarlierHistory?(): Promise<boolean>;
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
  /** Signed-in account DID (for publishing Main's live controls to Feed's AskBox). */
  account?: string;
  /** Owner's TinyCloud session (enables Main's read grants, chat read access, and Courier setup). */
  tcw?: TinyCloudWeb;
  /** Main bot asks/web API; when present, BotView renders TrustBot's full controls and publishes to Feed. */
  mainApi?: BotsApi;
}

const NOOP_ASKS_API: AsksApi = {
  getAsks: () => Promise.reject(new Error("disabled")),
  setAsks: () => Promise.reject(new Error("disabled")),
  listRequests: () => Promise.reject(new Error("disabled")),
  answerRequest: () => Promise.reject(new Error("disabled")),
  getMainWeb: () => Promise.reject(new Error("disabled")),
};

function MainBridgeSync({ account, chats, asks, onTurnFinished }: { account: string; chats: BotChats; asks: ReturnType<typeof useAsks>; onTurnFinished: () => void }) {
  const mainState = useBotChat(chats, "main");
  const working = isWorking(mainState.turn);
  const wasWorking = useRef(false);
  useEffect(() => {
    if (wasWorking.current && !working) onTurnFinished();
    wasWorking.current = working;
  }, [working, onTurnFinished]);
  useEffect(() => {
    mainBotBridgeStore.set({
      account,
      working,
      asks,
      sendMain: (text: string) => void chats.send("main", text),
    });
  }, [account, working, asks, chats]);
  useEffect(() => () => {
    if (mainBotBridgeStore.snapshot()?.account === account) mainBotBridgeStore.set(null);
  }, [account]);
  return null;
}

export function BotsChat<Bot extends ControllerBot>({
  controller, selected, faceOf, history, active, onReconnect, chatApi = defaultChatApi, onChats, strip, account, tcw, mainApi,
}: BotsChatProps<Bot>) {
  const refreshRequests = useRef<() => void>(() => {});
  const sourceFor = useCallback((key: string): BotChatSource => {
    const authorize = async () => {
      if (!history || history.saves?.(key) === false || !(await history.enabled())) return false;
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
      send: (text, onEvent, signal, options) => chatApi.send(key, text, onEvent, signal, options),
      prepare: async () => { await authorize(); },
      onNoReply: key === "main" ? () => refreshRequests.current() : undefined,
    };
  }, [chatApi, history]);
  const chats = useBotChats(sourceFor);
  useEffect(() => { onChats?.(chats); }, [chats, onChats]);
  useEffect(() => () => onChats?.(null), [onChats]);

  // Flush any message submitted from Feed's AskBox while BotsSurface was loading.
  useEffect(() => {
    if (!chats || !account) return;
    const queued = takePendingMainSend(account);
    if (queued) void chats.send("main", queued);
  }, [chats, account]);

  const bots = viewableBots(controller);
  const listed = bots.find((bot) => bot.key === selected);
  const waiting = !listed && selected !== "main" && controller.status === "loading";
  const shown = listed ?? MAIN;

  const sendMainAppReply = useCallback((reply: Parameters<BotChats["sendAppReply"]>[1]) => {
    chats?.sendAppReply("main", reply);
  }, [chats]);
  const asks = useAsks(mainApi ?? NOOP_ASKS_API, {
    open: active && shown.key === "main",
    onDecided: sendMainAppReply,
    owner: tcw?.did ?? account,
  });
  refreshRequests.current = asks.refresh;

  const noteWeb = asks.noteWeb;
  const webAccess = useMemo(() => mainApi && typeof mainApi.getMainWeb === "function" && typeof mainApi.setMainWeb === "function" ? {
    getMainWeb: mainApi.getMainWeb,
    setMainWeb: async (...args: Parameters<BotsApi["setMainWeb"]>) => {
      const stored = await mainApi.setMainWeb(...args);
      noteWeb(stored.mode !== "off");
      return stored;
    },
  } : undefined, [mainApi, noteWeb]);

  const [readRevision, setReadRevision] = useState(0);
  const revokeOwnerRead = useCallback((cid: string) => {
    if (!tcw) return Promise.reject(new Error("read_signed_out"));
    return revokeReadGrant(tcw, cid);
  }, [tcw]);
  const meetings = useMemo(() => tcw && typeof tcw.did === "string" ? {
    readSettings,
    setReadArea,
    signReadGrant: (serviceDid: string, areas: Parameters<typeof signReadGrant>[2]) => signReadGrant(tcw, serviceDid, areas),
    revokeReadGrant: revokeOwnerRead,
    stopStandingArea: async (area: Parameters<typeof setReadArea>[0]) => {
      const { stopStandingArea } = await import("./trustbotStandingReads");
      await stopStandingArea(area, revokeOwnerRead);
    },
    chatReadAccess: {
      listChats: async () => (await Promise.all([listThreads(tcw), listTelegramChats(tcw)])).flat(),
      readDeniedChatIds,
      setChatDenied,
    },
  } : undefined, [tcw, readRevision, revokeOwnerRead]);

  useEffect(() => {
    if (!tcw || typeof tcw.did !== "string") return;
    let current = true;
    const renew = () => {
      void ensureTrustBotReadGrant(tcw).then((renewed) => {
        if (current && renewed) setReadRevision((rev) => rev + 1);
      });
    };
    renew();
    const timer = setInterval(renew, NOTICE_MS);
    return () => { current = false; clearInterval(timer); };
  }, [tcw]);

  const newChat = useMemo(() => mainApi && chats ? {
    start: () => newMainChat(),
    onStarted: () => { chats.clear("main"); asks.refresh(); },
  } : undefined, [mainApi, chats, asks.refresh]);

  const onNotNow = useCallback((lineId: string, area: Parameters<BotChats["notNow"]>[2]) => {
    chats?.notNow("main", lineId, area);
  }, [chats]);
  const onAskAgain = useCallback((lineId: string) => {
    chats?.askAgain("main", lineId);
  }, [chats]);

  const mainControls: MainBotControls | undefined = shown.key === "main" && (mainApi || meetings)
    ? {
      active,
      asks: mainApi ? asks : undefined,
      meetings,
      webAccess,
      courier: Boolean(tcw && typeof tcw.did === "string"),
      newChat,
      onNotNow,
      onAskAgain,
    }
    : undefined;

  // The expiry notice of the bot on screen, read again every 30 seconds while the Chat slot shows. The permission is
  // handed over first, as Main's chat over Home does, so a notice that a renewal settles goes away.
  const [notice, setNotice] = useState<{ key: string; notice: HistoryNotice | null } | null>(null);
  useEffect(() => {
    if (!active || !history || waiting || history.saves?.(shown.key) === false) return;
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

  const requestEarlier = history?.saves?.(shown.key) === false ? undefined : history?.requestEarlierHistory;
  const reloadShown = useCallback(() => chats?.loadHistory(shown.key), [chats, shown.key]);
  const earlierHistory = useMemo<EarlierHistoryMove | undefined>(
    () => requestEarlier ? { bot: shown.key, request: requestEarlier, reload: reloadShown } : undefined,
    [requestEarlier, shown.key, reloadShown],
  );

  if (!chats || waiting) return <div className="h-full bg-background" data-bot-view-loading="" />;
  const view: ViewBot = { key: shown.key, name: shown.name, private: shown.environment === "private", face: faceOf(shown) };
  const { manage: actions } = controller;
  const manage: BotManagement | undefined = actions && shown.shape && shown.colour
    ? {
      shape: shown.shape,
      colour: shown.colour,
      // The main bot's old name is taken for every other bot (TC-3790).
      takenNames: [...bots.filter((bot) => bot.key !== shown.key).map((bot) => bot.name), ...(shown.key === "main" ? [] : [MAIN_BOT_OLD_NAME])],
      update: (input) => actions.update(shown.key, input),
      remove: shown.key === "main" ? undefined : () => actions.remove(shown.key),
    }
    : undefined;
  return (
    <>
      {account && mainApi ? <MainBridgeSync account={account} chats={chats} asks={asks} onTurnFinished={asks.refresh} /> : null}
      <BotView
        bot={view}
        chats={chats}
        notice={notice?.key === shown.key ? notice.notice : null}
        acknowledgeNotice={acknowledgeNotice}
        onReconnect={onReconnect}
        strip={strip}
        manage={manage}
        earlierHistory={earlierHistory}
        main={mainControls}
      />
    </>
  );
}
