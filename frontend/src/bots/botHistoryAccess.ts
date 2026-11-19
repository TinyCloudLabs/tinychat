// Saving each bot's history into the owner's space, for the Bots view (TC-3325). Main keeps exactly what its chat over
// Home does: the same approval, the same grant for its own directory and the same reader.
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import type { BotHistoryAccess } from "./BotsChat";
import { authorizeBotHistory } from "./historyAuthorization";
import { botHistoryEnabled, ensureBotHistoryGrant } from "./historyGrant";
import { readBotHistory } from "./historyRead";

export function historyAccessFor(tcw: TinyCloudWeb): BotHistoryAccess {
  return {
    enabled: botHistoryEnabled,
    authorize: () => authorizeBotHistory(tcw),
    async grant(key) {
      if (key !== "main") throw new Error("history_bot_key_invalid");
      await ensureBotHistoryGrant(tcw);
    },
    async read(key, signal) {
      if (key !== "main") throw new Error("history_bot_key_invalid");
      return readBotHistory(tcw, signal);
    },
  };
}
