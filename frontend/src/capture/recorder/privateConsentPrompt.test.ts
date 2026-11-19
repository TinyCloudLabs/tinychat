import { expect, test } from "bun:test";
import { markPrivateConsentPrompted, privateConsentWasPrompted, PRIVATE_CONSENT_PROMPT_KEY } from "./privateConsentPrompt";
import { accountStorageKey } from "@/lib/voiceNotes/sourcePins";
import { VOICE_NOTE_CONSENT_VERSION } from "@/lib/voiceNotes/voiceNoteTranscription";

test("automatic Private disclosure is remembered per account and consent version across launches", () => {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  expect(privateConsentWasPrompted("did:a", storage)).toBe(false);
  markPrivateConsentPrompted("did:a", storage);
  expect(privateConsentWasPrompted("did:a", storage)).toBe(true);
  expect(privateConsentWasPrompted("did:b", storage)).toBe(false);
  values.set(accountStorageKey(PRIVATE_CONSENT_PROMPT_KEY, "did:a"), "1");
  expect(privateConsentWasPrompted("did:a", storage)).toBe(false);
  expect(VOICE_NOTE_CONSENT_VERSION).toBe("2");
});
