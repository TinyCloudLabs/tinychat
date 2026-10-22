// The ONE place that decides which KV folders a local replica may mirror.
//
// Rules (TC-1189 / exo-replication plan §1, §4):
//  - text only: transcript bodies and the audio-free immutable transcript revisions;
//  - never audio (`…/<source>/audio/…`), never `note.md` (it lives INSIDE the audio folder,
//    voiceNoteStore.ts voiceNoteMarkdownKvKey), never `vault/` or secrets;
//  - never mutable control state (sync-attempt, Drive cursor/progress, pending-reconcile snapshot,
//    transcript-history): a stale local copy of those could drive a wrong write;
//  - thread KV is NOT listed: tinychat keeps threads in SQL (threadStore.ts), no KV key is built
//    under `threads/`.
//
// Every prefix is built by the same key builders the app writes with, so a key-layout change
// cannot silently drift from what is mirrored. Prefixes are full in-space paths
// (`xyz.tinycloud.tinychat/connectors/<source>/transcript/`), the same string `tcw.kv.get(key)`
// receives, each its own folder ending in `/`.
import { transcriptKvKey } from "@tinyboilerplate/core";
import { SUPPORTED_MEETING_SOURCES } from "../meetingChat/corpus";
import { transcriptRevKvPrefix } from "../voiceNotes/voiceNoteRows";
import { VOICE_NOTE_SOURCE } from "../voiceNotes/voiceNoteStore";

/** Folder of transcript bodies for one source: `<app>/connectors/<source>/transcript/`. */
export function transcriptBodyPrefix(source: string): string {
  return transcriptKvKey(source, "");
}

export function replicationPrefixes(): string[] {
  const prefixes = [
    ...SUPPORTED_MEETING_SOURCES.map(transcriptBodyPrefix),
    transcriptRevKvPrefix(VOICE_NOTE_SOURCE),
  ];
  for (const prefix of prefixes) {
    if (!prefix.endsWith("/") || prefix.includes("/audio/") || prefix.includes("vault/")) {
      throw new Error("Replication prefix is not an audio-free text folder");
    }
  }
  return prefixes;
}
