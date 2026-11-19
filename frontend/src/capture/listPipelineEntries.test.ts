import { describe, expect, test } from "bun:test";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { notePipeline, type StepState } from "@/lib/voiceNotes/notePipeline";
import { buildNotePipelineInput, rowHasCommittedAudio, type NotePipelineSource } from "@/lib/voiceNotes/useNotePipeline";
import { voiceNoteMarkdownKvKey } from "@/lib/voiceNotes/voiceNoteStore";
import type { LibraryItem } from "./library/LibraryRow";
import { listPipelineEntries } from "./listPipelineEntries";

describe("listPipelineEntries", () => {
  test("passes listing metadata through so a synced saved note is done in the list", () => {
    const id = "rec-synced";
    const editedAt = "2026-10-11T10:00:00.000Z";
    const item: LibraryItem = {
      id: "row-synced",
      source: "exo-voice-note",
      sourceId: id,
      title: "Synced note",
      startedAt: editedAt,
      durationSecs: 30,
      metadata: {
        transcription_outcome: "transcribed",
        note_kv_key: voiceNoteMarkdownKvKey(id),
        note_edited_at: editedAt,
      },
    };
    const entry = listPipelineEntries([item], {} as TinyCloudWeb)[0]!;
    expect(entry.source.durationSecs).toBe(item.durationSecs);
    expect(entry.source.metadata).toEqual(item.metadata);
    const input = buildNotePipelineInput({
      id: entry.id,
      device: "phone",
      online: true,
      saved: true,
      rowMetadata: entry.source.metadata,
      localNote: { editedAt, hasContent: true },
      native: { transcriber: "off", stt: null },
      capture: { finalizing: false, issue: null },
      pending: null,
      lane: { busy: false, depth: 0 },
      onDeviceStatus: null,
      transcriptSync: null,
      cloudJob: null,
      noteSync: { syncing: false, failed: false, skip: null, syncedAt: null },
    });

    expect(notePipeline(input).done).toBe(true);
  });

  test("keeps missing listing metadata distinct from a confirmed empty row", () => {
    const base: LibraryItem = {
      id: "row-missing-metadata",
      source: "exo-voice-note",
      sourceId: "rec-missing-metadata",
      title: "Voice note",
      startedAt: null,
      durationSecs: null,
    };

    expect(listPipelineEntries([base], {} as TinyCloudWeb)[0]?.source.metadata).toBeUndefined();
    expect(listPipelineEntries([{ ...base, metadata: null }], {} as TinyCloudWeb)[0]?.source.metadata).toBeNull();
  });

  test("a pasted transcript with text has its space step done, not waiting to upload", () => {
    const item: LibraryItem = {
      id: "row-pasted", source: "exo-voice-note", sourceId: "pasted-with-text", title: "Pasted", startedAt: null, durationSecs: null,
      metadata: { source: "pasted", capture: "pasted", transcription_outcome: "transcribed", has_transcript_text: 1 },
    };
    const entry = listPipelineEntries([item], {} as TinyCloudWeb)[0]!;

    expect(entry.source.audioSaved).toBe(true);
    expect(spaceState(entry)).toBe("done");
  });

  test("a pasted transcript without text is not counted as saved", () => {
    const item: LibraryItem = {
      id: "row-pasted-empty", source: "exo-voice-note", sourceId: "pasted-empty", title: "Pasted", startedAt: null, durationSecs: null,
      metadata: { source: "pasted", capture: "pasted", transcription_outcome: "pending", has_transcript_text: 0 },
    };
    const entry = listPipelineEntries([item], {} as TinyCloudWeb)[0]!;

    expect(entry.source.audioSaved).toBe(false);
    expect(spaceState(entry)).toBe("waiting");
  });

  test("a pasted detail row is saved only when its transcript text is non-blank", () => {
    const withText = { source: "pasted", capture: "pasted", transcription_outcome: "transcribed", transcript_text: "Hello" };
    const blank = { source: "pasted", capture: "pasted", transcription_outcome: "transcribed", transcript_text: "  \n" };
    expect(rowHasCommittedAudio(withText)).toBe(true);
    expect(rowHasCommittedAudio(blank)).toBe(false);
  });

  test("a recorded note with no stored audio is still waiting to upload", () => {
    const item: LibraryItem = {
      id: "row-recorded", source: "exo-voice-note", sourceId: "recorded-no-audio", title: "Recorded", startedAt: null, durationSecs: 12,
      metadata: { transcription_outcome: "transcribed", transcript_text: "Hello" },
    };
    const entry = listPipelineEntries([item], {} as TinyCloudWeb)[0]!;

    expect(entry.source.audioSaved).toBe(false);
    expect(spaceState(entry)).toBe("waiting");
  });

/** The space step of the pipeline the list would draw for this entry, with the same facts the list uses. */
function spaceState(entry: { id: string; source: NotePipelineSource }): StepState | undefined {
  const input = buildNotePipelineInput({
    id: entry.id,
    device: "phone",
    online: true,
    saved: entry.source.audioSaved === true,
    rowMetadata: entry.source.metadata,
    localNote: null,
    native: null,
    capture: { finalizing: false, issue: null },
    pending: null,
    lane: { busy: false, depth: 0 },
    onDeviceStatus: null,
    transcriptSync: null,
    cloudJob: null,
    noteSync: { syncing: false, failed: false, skip: null, syncedAt: null },
  });
  return notePipeline(input).steps.find((step) => step.key === "space")?.state;
}
});
