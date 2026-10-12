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

/**
 * Only an explicit, known delivery value turns the browser courier on. A backend that omits the
 * field (or sends one this build does not know) must not trigger minting or the browser's
 * ten-minute fallback deferral. `schema_missing` is still on: it is the browser's repair cue.
 */
export function transcriptDeliveryEnabled(status: DelegationResponse): boolean {
  return status.delivery === "enabled" || status.delivery === "schema_missing";
}

export function resolveTranscriptConsentStatus(address: string, status: DelegationResponse | null): void {
  if (consentAddress !== address.toLowerCase()) return;
  if (!status) { publish("unknown"); return; }
  if (status.status === "active" && status.verified) {
    // A grant the server still holds is disclosed even with delivery off: the backend removes it
    // on a later status read or sweep, and reports it until then. schema_missing is retryable.
    publish(status.delivery === "enabled" ? "active" : "unknown");
    return;
  }
  // No usable grant yet. With the courier on it is about to mint one without a prompt, so the
  // copy must already disclose it; only a courier that will not act keeps the original copy.
  publish(transcriptDeliveryEnabled(status) ? "unknown" : "inactive");
}

export function clearTranscriptConsentStatus(address: string | null): void {
  if (address && consentAddress !== address.toLowerCase()) return;
  consentAddress = null;
  publish("unknown");
}

export function serverDeliveryActive(): boolean { return enabled; }
export function setServerDeliveryActive(active: boolean): void { enabled = active; }
