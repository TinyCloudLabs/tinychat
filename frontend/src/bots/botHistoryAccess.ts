// Saving each bot's history into the owner's space, for the Bots view (TC-3325). Main keeps exactly what its chat over
// Home does: the same approval, the same grant for its own directory and the same reader, and a failure there fails
// the history as it does over Home. Every other bot gets a grant for its own directory only, and its history is read
// from there; while the backend takes no grant for it, its chat works from the service's copy alone, so a failed
// grant or read leaves the conversation as the service has it instead of stopping the bot.
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import type { BotHistoryAccess } from "./BotsChat";
import { authorizeBotHistory } from "./historyAuthorization";
import { botHistoryEnabled, ensureBotHistoryGrant, ensureSiblingHistoryGrant } from "./historyGrant";
import { readBotHistory, readHistoryForBot } from "./historyRead";

export function historyAccessFor(tcw: TinyCloudWeb): BotHistoryAccess {
  return {
    enabled: botHistoryEnabled,
    authorize: () => authorizeBotHistory(tcw),
    async grant(key) {
      if (key === "main") return ensureBotHistoryGrant(tcw);
      await ensureSiblingHistoryGrant(tcw, key).catch(() => {});
    },
    async read(key, signal) {
      if (key === "main") return readBotHistory(tcw, signal);
      return readHistoryForBot(tcw, key, signal).catch(() => []);
    },
  };
}
