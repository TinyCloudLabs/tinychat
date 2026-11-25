// Saving each bot's history into the owner's space, for the Bots view (TC-3325). Main keeps exactly what its chat over
// Home does: the same approval, the same grant for its own directory and the same reader, and a failure there fails
// the history as it does over Home. Every other bot saves no history: the backend has no route that takes a grant or
// serves a notice for it (TC-3813), so its chat works from the service's copy alone and nothing is requested for it.
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import type { BotHistoryAccess } from "./BotsChat";
import { authorizeBotHistory } from "./historyAuthorization";
import { botHistoryEnabled, ensureBotHistoryGrant, ensureSiblingHistoryGrant } from "./historyGrant";
import { readBotHistory, readHistoryForBot } from "./historyRead";

export function historyAccessFor(tcw: TinyCloudWeb): BotHistoryAccess {
  return {
    enabled: botHistoryEnabled,
    authorize: () => authorizeBotHistory(tcw),
    saves: (key) => key === "main",
    requestEarlierHistory: async () => (await import("./earlierHistoryRequest")).requestEarlierHistoryAccess(tcw),
    async grant(key) {
      if (key === "main") return ensureBotHistoryGrant(tcw);
      await ensureSiblingHistoryGrant(tcw, key).catch(() => {});
    },
    async read(key, signal) {
      if (key === "main") return readBotHistory(tcw, signal, { reseal: true });
      return readHistoryForBot(tcw, key, signal, { reseal: true }).catch(() => []);
    },
  };
}
