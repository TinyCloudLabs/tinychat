import { describe, expect, test } from "bun:test";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { notePipeline } from "@/lib/voiceNotes/notePipeline";
import { buildNotePipelineInput } from "@/lib/voiceNotes/useNotePipeline";
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
    expect(entry.source.metadata).toEqual(item.metadata);
    const input = buildNotePipelineInput({
      id: entry.id,
      device: "phone",
      online: true,
      saved: entry.source.saved,
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
});
