// The Bots view in the Chat slot (TC-3325): the account's bots, the bot picked, and New bot. Its own chunk: the Chat
// slot (ChatSlot.tsx) loads it once the account has picked Bots, so an account on Classic never fetches it.
import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import { useSizeClass } from "@/lib/sizeClass";
import { navKindFor } from "@/shell/navItems";
import { MAIN_BOT } from "./BotAvatar";
import { PhoneBotStrip } from "./BotNav";
import { botChatApi as defaultChatApi, botRosterApi as defaultRosterApi, type BotChatApi } from "./botChatApi";
import { botForPath, botPath, saveLastBot } from "./botPath";
import type { BotRosterApi, CreateBotInput, RosterBot } from "./botRosterApi";
import { BotsChat, viewableBots, type BotHistoryAccess, type ControllerBot } from "./BotsChat";
import { botsNavStore, type BotsNavState } from "./botsNav";
import { CREATE_BOT_STRINGS, MAIN_BOT_NAME } from "./botsStrings";
import { CreateBotDialog } from "./CreateBotDialog";
import type { BotChats } from "./useBotChat";
import { useBots } from "./useBots";

const faceOf = ({ key, name, shape, colour }: RosterBot | ControllerBot) => (shape && colour ? { key, name, shape, colour } : MAIN_BOT);

export function BotsSurface({ account, active, onReconnect, chatApi = defaultChatApi, rosterApi = defaultRosterApi, history }: {
  account: string;
  active: boolean;
  onReconnect?: () => void;
  chatApi?: BotChatApi;
  rosterApi?: BotRosterApi;
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
    const mainName = roster.bots.find((bot) => bot.key === "main")?.name ?? MAIN_BOT_NAME;
    const reason = enabled ? null : copy.atLimit(limit.max, roster.bots.some((bot) => bot.key !== "main"), mainName) || null;
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
