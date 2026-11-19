// What the Chat slot shows (TC-3325): the classic chat, or the Bots view when the account picked Bots in Settings
// and the backend lets it use bots. The classic chat stays mounted, hidden, while Bots shows, so its thread, drafts
// and first-load signal are as they were when the owner switches back. An account on Classic makes no bots calls.
import { useMemo, type ReactNode } from "react";
import { useLocation } from "react-router-dom";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { MAIN_BOT } from "./BotAvatar";
import { historyAccessFor } from "./botHistoryAccess";
import type { BotChatApi } from "./botChatApi";
import { botsApi as defaultBotsApi, type BotsApi } from "./botsApi";
import { botForPath } from "./botPath";
import { BotsChat, viewableBots, type BotHistoryAccess, type BotsController } from "./BotsChat";
import { useChatView } from "./chatViewSetting";
import { useBotsAdmitted } from "./useBotsAdmitted";

const NO_ROSTER: BotsController = { status: "failed", roster: null };

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
  /** Saving history into the owner's space; by default the session's (botHistoryAccess.ts). */
  history?: BotHistoryAccess | null;
}

export function ChatSlot({ classic, account, tcw, active, onReconnect, api = defaultBotsApi, chatApi, history }: ChatSlotProps) {
  const [view] = useChatView(account);
  const chosen = account !== null && view === "bots";
  const admitted = useBotsAdmitted(chosen ? api : null);
  const bots = chosen && admitted;
  const sessionHistory = useMemo(() => historyAccessFor(tcw), [tcw]);
  const { pathname } = useLocation();
  const controller = NO_ROSTER;
  const keys = new Set(viewableBots(controller).map((bot) => bot.key));
  // While the list loads every key counts, so an address naming another bot isn't sent to Main before it arrives.
  const selected = botForPath(pathname, account, (key) => controller.status === "loading" || keys.has(key));
  return (
    <>
      <div className={bots ? "hidden" : "h-full"} data-chat-view="classic">{classic}</div>
      {bots ? (
        <div className="h-full" data-chat-view="bots">
          <BotsChat controller={controller} selected={selected} faceOf={() => MAIN_BOT} history={history === undefined ? sessionHistory : history}
            active={active} onReconnect={onReconnect} chatApi={chatApi} />
        </div>
      ) : null}
    </>
  );
}
