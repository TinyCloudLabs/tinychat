// What the Chat slot shows (TC-3325): the classic chat, or the Bots view when the account picked Bots in Settings
// and the backend lets it use bots. The classic chat stays mounted, hidden, while Bots shows, so its thread, drafts
// and first-load signal are as they were when the owner switches back. An account on Classic makes no bots calls.
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { useSizeClass } from "@/lib/sizeClass";
import { navKindFor } from "@/shell/navItems";
import { MAIN_BOT } from "./BotAvatar";
import { PhoneBotStrip } from "./BotNav";
import { historyAccessFor } from "./botHistoryAccess";
import { botChatApi as defaultChatApi, botRosterApi as defaultRosterApi, type BotChatApi } from "./botChatApi";
import { botForPath, botPath, saveLastBot } from "./botPath";
import type { BotRosterApi, CreateBotInput, RosterBot } from "./botRosterApi";
import { botsApi as defaultBotsApi, type BotsApi } from "./botsApi";
import { BotsChat, viewableBots, type BotHistoryAccess, type ControllerBot } from "./BotsChat";
import { botsNavStore, type BotsNavState } from "./botsNav";
import { CREATE_BOT_STRINGS } from "./botsStrings";
import { useChatView } from "./chatViewSetting";
import { CreateBotDialog } from "./CreateBotDialog";
import type { BotChats } from "./useBotChat";
import { useBots } from "./useBots";
import { useBotsAdmitted } from "./useBotsAdmitted";

export interface ChatSlotProps {
  classic: ReactNode;
  /** The signed-in account's DID: the Chat view setting is kept per account. Null: Classic, with no bots calls. */
  account: string | null;
  tcw: TinyCloudWeb;
  /** The Chat slot is on screen. */
  active: boolean;
  onReconnect?: () => void;
  api?: BotsApi;
  chatApi?: BotChatApi;
  rosterApi?: BotRosterApi;
  /** Saving history into the owner's space; by default the session's (botHistoryAccess.ts). */
  history?: BotHistoryAccess | null;
}

export function ChatSlot({ classic, account, tcw, active, onReconnect, api = defaultBotsApi, chatApi = defaultChatApi, rosterApi = defaultRosterApi, history }: ChatSlotProps) {
  const [view] = useChatView(account);
  const chosen = account !== null && view === "bots";
  const admitted = useBotsAdmitted(chosen ? api : null);
  const sessionHistory = useMemo(() => historyAccessFor(tcw), [tcw]);
  const bots = chosen && admitted && account !== null;
  return (
    <>
      <div className={bots ? "hidden" : "h-full"} data-chat-view="classic">{classic}</div>
      {bots ? (
        // Keyed by account: another account's bots, conversations and drafts never carry over.
        <BotsSurface key={account} account={account} active={active} onReconnect={onReconnect} chatApi={chatApi} rosterApi={rosterApi}
          history={history === undefined ? sessionHistory : history} />
      ) : null}
    </>
  );
}

const faceOf = ({ key, name, shape, colour }: RosterBot | ControllerBot) => (shape && colour ? { key, name, shape, colour } : MAIN_BOT);

function BotsSurface({ account, active, onReconnect, chatApi, rosterApi, history }: {
  account: string;
  active: boolean;
  onReconnect?: () => void;
  chatApi: BotChatApi;
  rosterApi: BotRosterApi;
  history: BotHistoryAccess | null;
}) {
  const { status, roster, reload, create } = useBots(rosterApi);
  // Edit and Delete bot (the bot panel) change the list, which does not update live, so it is read again after each.
  const manage = useMemo(() => ({
    update: async (key: string, input: Partial<CreateBotInput>) => {
      await rosterApi.update(key, input);
      await reload();
    },
    remove: async (key: string) => {
      await rosterApi.remove(key);
      await reload();
    },
  }), [rosterApi, reload]);
  const controller = useMemo(() => ({ status, roster, manage }), [status, roster, manage]);
  const viewable = useMemo(() => viewableBots(controller), [controller]);
  const { pathname } = useLocation();
  const navigate = useNavigate();
  // While the list loads every key counts, so an address naming another bot isn't sent to Main before it arrives.
  const selected = botForPath(pathname, account, (key) => status === "loading" || viewable.some((bot) => bot.key === key));
  const listed = viewable.some((bot) => bot.key === selected);
  useEffect(() => {
    if (active && listed) saveLastBot(account, selected);
  }, [account, active, listed, selected]);

  const [chats, setChats] = useState<BotChats | null>(null);
  const [creating, setCreating] = useState(false);
  const openCreate = useCallback(() => setCreating(true), []);
  const newBot = useMemo((): BotsNavState["newBot"] => {
    const enabled = !!roster && (roster.canCreate.private || roster.canCreate.regular);
    const limit = roster?.limits?.private;
    if (!roster || !limit) return { enabled, counter: null, reason: null, open: openCreate };
    const copy = CREATE_BOT_STRINGS.cap[roster.capMode];
    const reason = enabled ? null : copy.atLimit(limit.max, roster.bots.some((bot) => bot.key !== "main")) || null;
    return { enabled, counter: copy.count(limit.used, limit.max), reason, open: openCreate };
  }, [roster, openCreate]);
  const navBots = useMemo(() => viewable.map((bot) => ({ key: bot.key, name: bot.name, face: faceOf(bot) })), [viewable]);
  useEffect(() => {
    botsNavStore.set({ bots: navBots, selected, chatShown: active, chats, newBot });
  }, [navBots, selected, active, chats, newBot]);
  useEffect(() => () => botsNavStore.set(null), []);

  const phone = navKindFor(useSizeClass()) === "tabbar";
  return (
    <div className="h-full" data-chat-view="bots">
      <BotsChat controller={controller} selected={selected} faceOf={faceOf} history={history} active={active} onReconnect={onReconnect}
        chatApi={chatApi} onChats={setChats} strip={phone ? <PhoneBotStrip /> : null} />
      {roster ? (
        <CreateBotDialog open={creating} onOpenChange={setCreating} roster={roster} onCreate={create}
          onCreated={(bot) => navigate(botPath(bot.key))} />
      ) : null}
    </div>
  );
}
