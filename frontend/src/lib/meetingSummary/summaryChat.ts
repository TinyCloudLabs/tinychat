// TC-1152 v1b-b: the model call a combined meeting's summary makes: the chat route (`completeChat`, the same
// /api/chat proxy and the same credits as meeting chat) with the default chat model. Kept apart from the runner
// so the runner has no billing client in it. The billing client loads on first use (the usage meter), not with
// the Capture surface.
import type { SessionStore } from "@tinyboilerplate/client";
import { DEFAULT_CHAT_MODEL } from "@tinyboilerplate/core";

import { completeChat, emitReceipt } from "@/lib/chatApi";

import type { GenerateDeps } from "./generateSummary";

export function chatComplete(backendUrl: string, sessionStore: SessionStore): GenerateDeps["complete"] {
  return (messages, { maxTokens, signal }) => {
    const model = DEFAULT_CHAT_MODEL;
    let folded = false;
    return completeChat({
      backendUrl,
      sessionStore,
      model,
      messages,
      maxTokens,
      abortSignal: signal,
      // The usage meter only (the ledger is the backend's): the same fold compaction does. Never throws.
      onUsage: (usage) => {
        if (folded) return;
        folded = true;
        void import("@/lib/billingApi")
          .then(async ({ aggregateTurnCredits, createBillingClient, getCachedRates }) => {
            const rates = await getCachedRates(createBillingClient(backendUrl, sessionStore));
            const rate = rates.models.find((m) => m.id === model);
            if (!rate) return;
            const { backgroundCredits } = aggregateTurnCredits(0, [{ rates: rate, promptTokens: usage.promptTokens, completionTokens: usage.completionTokens }]);
            if (backgroundCredits > 0) emitReceipt(model, backgroundCredits, model);
          })
          .catch(() => undefined);
      },
    });
  };
}
