// The voice-note store's save, swappable in bun tests (TC-761): the tests that
// exercise the recorder's saves mock `saveVoiceNote` with a call through here,
// and every other test keeps the real one (`save` is null between tests).
import type { saveVoiceNote } from "@/lib/voiceNotes/voiceNoteStore";

export const fakeVoiceNoteStore: { save: typeof saveVoiceNote | null } = { save: null };
