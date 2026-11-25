// The model calls of one naming run: NAMING_READINGS readings of the same request, sent at once through the chat
// route (`completeChat`, the same /api/chat proxy and the same credits as meeting summaries). Kept apart from the
// runner so the runner has no chat or billing client in it. The billing client loads on first use (the usage
// meter), not with the Capture surface.
import type { SessionStore } from "@tinyboilerplate/client";
import type { BackgroundModelId } from "@tinyboilerplate/core";

import { completeChat, emitReceipt, PaywallError, type ChatMessage } from "@/lib/chatApi";

import { NAMING_READINGS } from "./parseNaming";

/** The model that reads a transcript for its speakers' names. The backend admits it for background calls only: a request has to carry an output cap and a reasoning setting. */
export const NAMING_MODEL: BackgroundModelId = "moonshotai/kimi-k3.1-pro";
/** The model's reasoning counts against this cap; without the reasoning setting below it can spend all of it and answer nothing. */
export const NAMING_MAX_OUTPUT_TOKENS = 4096;
/** A request larger than this is not sent. The API takes bodies up to 1 MB, and a Cyrillic or CJK transcript reaches that at a half or a third of the characters a Latin one does. */
export const MAX_NAMING_REQUEST_BYTES = 900_000;

/** One reading's request, for the size check and for the call alike. */
const request = (messages: ChatMessage[]) =>
  ({ model: NAMING_MODEL, messages, maxOutputTokens: NAMING_MAX_OUTPUT_TOKENS, reasoning: "minimal" }) as const;

/**
 * The bytes of the JSON body one reading sends: what `streamChat` posts for `request` (chatApi.ts). Written out
 * here so that the chat module the app boots with carries nothing for it; a test holds the two bodies equal.
 */
export function namingRequestBytes(messages: ChatMessage[]): number {
  const { model, maxOutputTokens, reasoning } = request(messages);
  return new TextEncoder().encode(JSON.stringify({ model, messages, max_output_tokens: maxOutputTokens, reasoning })).byteLength;
}

export interface NamingReadings {
  /** The replies of the readings that came back; a reading that failed is left out. */
  replies: string[];
  /** A reading was refused for credits. */
  paywall: boolean;
}

export type ReadNames = (messages: ChatMessage[], signal: AbortSignal) => Promise<NamingReadings>;

export function chatReadings(backendUrl: string, sessionStore: SessionStore): ReadNames {
  return async (messages, signal) => {
    const readings = await Promise.allSettled(Array.from({ length: NAMING_READINGS }, () => {
      let folded = false;
      return completeChat({
        backendUrl,
        sessionStore,
        ...request(messages),
        abortSignal: signal,
        // The usage meter only (the ledger is the backend's): the same fold a summary does. Never throws. A model
        // the cached rates do not list is not metered here.
        onUsage: (usage) => {
          if (folded) return;
          folded = true;
          void import("@/lib/billingApi")
            .then(async ({ aggregateTurnCredits, createBillingClient, getCachedRates }) => {
              const rates = await getCachedRates(createBillingClient(backendUrl, sessionStore));
              const rate = rates.models.find((m) => m.id === NAMING_MODEL);
              if (!rate) return;
              const { backgroundCredits } = aggregateTurnCredits(0, [{ rates: rate, promptTokens: usage.promptTokens, completionTokens: usage.completionTokens }]);
              if (backgroundCredits > 0) emitReceipt(NAMING_MODEL, backgroundCredits, NAMING_MODEL);
            })
            .catch(() => undefined);
        },
      });
    }));
    return {
      replies: readings.flatMap((reading) => (reading.status === "fulfilled" ? [reading.value] : [])),
      paywall: readings.some((reading) => reading.status === "rejected" && reading.reason instanceof PaywallError),
    };
  };
}
