import type { DelegationResponse } from "@tinyboilerplate/core";

let enabled = false;

export type TranscriptConsentState = "unknown" | "inactive" | "active";
let consentState: TranscriptConsentState = "unknown";
let consentAddress: string | null = null;
const listeners = new Set<() => void>();

export function transcriptConsentState(): TranscriptConsentState { return consentState; }
export function subscribeTranscriptConsent(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function publish(state: TranscriptConsentState): void {
  if (consentState === state) return;
  consentState = state;
  for (const listener of listeners) listener();
}

export function beginTranscriptConsentStatus(address: string): void {
  consentAddress = address.toLowerCase();
  publish("unknown");
}

export function resolveTranscriptConsentStatus(address: string, status: DelegationResponse | null): void {
  if (consentAddress !== address.toLowerCase()) return;
  if (!status) { publish("unknown"); return; }
  if (status.delivery === "disabled" || status.status !== "active" || !status.verified) {
    publish("inactive");
    return;
  }
  // schema_missing is retryable; a signed, active grant still exists.
  publish(status.delivery === "enabled" ? "active" : "unknown");
}

export function clearTranscriptConsentStatus(address: string | null): void {
  if (address && consentAddress !== address.toLowerCase()) return;
  consentAddress = null;
  publish("unknown");
}

export function serverDeliveryActive(): boolean { return enabled; }
export function setServerDeliveryActive(active: boolean): void { enabled = active; }
