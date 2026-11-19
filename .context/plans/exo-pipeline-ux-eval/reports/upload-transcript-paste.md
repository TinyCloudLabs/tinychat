# Pasted transcript upload

## Summary

The Upload sheet now branches to audio or transcript paste. Paste accepts plain text, speaker lines and timestamps with a 1 MB UTF-8 limit. The Library shows a Pasted transcript label and the exact pasted line breaks, with no audio player.

The paste path writes an `exo-voice-note` connector row keyed by a UUID `source_id`, with `metadata.source` and `metadata.capture` set to `pasted`. It initializes the plain transcript mirror to `[]`, commits revision 1 through `commitVoiceNoteTranscript`, then emits one `library-changed` event. No audio key is written. The row remains pending until the commit verifies, when the shared commit path marks it transcribed.

## Downstream consumers

- `captureEvents` `library-changed` → mounted `useLibrary` re-lists once after the commit. The paste integration test asserts one notification.
- `meetingExplorer` and Library detail → the new row appears in the existing source list, resolves the authoritative `voice_note_transcript.body_key`, and displays the pasted text. The paste integration and detail tests cover this path.
- Meeting chat and agent retrieval → `SQL_MEETING_METADATA_QUERY` admits the committed row, and the existing retriever reads the same revision body by `source_id`. The paste integration test checks SQL admission; the focused corpus and retriever suites pass.

Backend private transcriber delivery and connector `meeting.transcribed` webhooks are **inbound provider HTTP handlers**, not subscribers to local TinyCloud space commits. They do not fire for a paste, just as they do not fire for a locally committed recorded note. There is no outbound transcript-ready webhook in this repo. The pasted note uses the existing committed-transcript path rather than forging a provider event.

## Verification

- Frontend build and typecheck passed.
- Focused upload, Library, meeting explorer, corpus, and retriever tests passed.
- Focused backend transcript delivery and connector webhook tests passed (65 tests).
- Backend typecheck still fails at `backend/src/services/transcript-delivery.ts:550`: `TranscriptionTranscript.gaps` is `unknown[]`, incompatible with `TranscriberTranscriptJson.gaps` (`TranscriptGap[]`). No backend files were changed here.
- No Rust changes.

## Integration overlap

#351 touches `LibraryRow.tsx`, `NoteDetailView.tsx`, `NoteDetailView.test.tsx`, `useLibrary.ts`, `meetingExplorer.ts`, and `voiceNoteRows.ts`; #348 has no overlap. #350 also touches `captureEvents.ts`, but this slice uses its existing event without editing that file. Amos should sequence this through the dev/0.8.0 integrator.
