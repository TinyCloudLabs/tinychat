// What the Chat slot shows (TC-3325): the classic chat, or the Bots view when the account picked Bots in Settings
// and the backend lets it use bots. The classic chat stays mounted, hidden, while Bots shows, so its thread, drafts
// and first-load signal are as they were when the owner switches back. An account on Classic makes no bots calls.
import { useEffect, type ReactNode } from "react";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { lazyTab } from "@/shell/lazyTab";
import type { BotChatApi } from "./botChatApi";
import type { BotRosterApi } from "./botRosterApi";
import { botsApi as defaultBotsApi, type BotsApi } from "./botsApi";
import type { BotHistoryAccess } from "./BotsChat";
import { useSavedChatView } from "./chatViewSetting";
import { useBotsAdmitted } from "./useBotsAdmitted";
import { preloadBotNav } from "./lazyBotNav";

const BotsSurface = lazyTab("Chat", () => import("./BotsSurface").then((m) => m.BotsSurface));

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

export function ChatSlot({ classic, account, tcw, active, onReconnect, api = defaultBotsApi, chatApi, rosterApi, history }: ChatSlotProps) {
  const [saved] = useSavedChatView(account);
  // Admitted accounts default to Bots unless they explicitly switched back to Classic in Settings.
  const wantsBots = account !== null && saved !== "classic";
  const admitted = useBotsAdmitted(wantsBots ? api : null);
  const bots = wantsBots && admitted === true;
  // Preload BotsSurface once the backend admits the account (or immediately when Bots was already saved).
  useEffect(() => {
    if (saved === "bots" || bots) void Promise.all([BotsSurface.preload(), preloadBotNav()]).catch(() => {});
  }, [saved, bots]);
  return (
    <>
      <div className={bots ? "hidden" : "h-full"} data-chat-view="classic">{classic}</div>
      {bots ? (
        // Keyed by account: another account's bots, conversations and drafts never carry over.
        <BotsSurface key={account} account={account} active={active} onReconnect={onReconnect} api={api} chatApi={chatApi} rosterApi={rosterApi}
          tcw={tcw} history={history} />
      ) : null}
    </>
  );
}
