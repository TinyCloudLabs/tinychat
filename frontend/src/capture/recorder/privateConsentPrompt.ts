import { accountStorageKey, VOICE_NOTE_CONSENT_VERSION } from "@/lib/voiceNotes/voiceNoteTranscription";

export const PRIVATE_CONSENT_PROMPT_KEY = "exo.voiceNotes.privateConsentPrompted";

/** Automatic disclosure is offered once per account and consent version. Review stays available. */
export function privateConsentWasPrompted(did: string, storage: Pick<Storage, "getItem"> | undefined = globalThis.localStorage): boolean {
  try { return storage?.getItem(accountStorageKey(PRIVATE_CONSENT_PROMPT_KEY, did)) === VOICE_NOTE_CONSENT_VERSION; }
  catch { return false; }
}

export function markPrivateConsentPrompted(did: string, storage: Pick<Storage, "setItem"> | undefined = globalThis.localStorage): void {
  try { storage?.setItem(accountStorageKey(PRIVATE_CONSENT_PROMPT_KEY, did), VOICE_NOTE_CONSENT_VERSION); }
  catch { /* The in-memory marker still prevents repeat prompts this session. */ }
}
