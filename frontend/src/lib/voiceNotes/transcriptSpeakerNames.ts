// What a new transcript does to the speaker names on a voice note's row. A module of its own, loaded by
// commitVoiceNoteTranscript only for a row that has shown a transcript and has names, so the entry chunk the web app
// boots from carries neither this nor speakerNames.ts (TC-2882). The read runs on the space lane through voiceNoteRows.ts.
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { speakerNamesAfterNewTranscript } from "@/capture/library/speakerNames";
import { query, type TranscriptToCommit, type VoiceNoteRow } from "./voiceNoteRows";

/**
 * What the transcript about to be mirrored onto `row` does to the row's speaker names, as a merge patch; null when
 * they all stay (`speakerNamesAfterNewTranscript`). Until that write the row mirrors the transcript it has shown so
 * far, the one its names were given to.
 */
export async function speakerNamesPatch(tcw: TinyCloudWeb, row: VoiceNoteRow, input: TranscriptToCommit,
  checkpoint: () => void): Promise<Record<string, unknown> | null> {
  const [stored] = await query(tcw, "SELECT participants FROM connector_meeting WHERE id = ?", [row.id], checkpoint);
  let labels: string[] = [];
  try {
    const participants: unknown = typeof stored?.[0] === "string" ? JSON.parse(stored[0]) : stored?.[0];
    if (Array.isArray(participants)) labels = participants.flatMap((entry: { name?: unknown } | null) =>
      typeof entry?.name === "string" ? [entry.name] : []);
  } catch {
    // Participants that cannot be read name no labels: the new transcript's set then differs from them.
  }
  const engine = row.metadata.transcription_engine;
  return speakerNamesAfterNewTranscript(row.metadata, { engine: typeof engine === "string" ? engine : null, labels },
    { engine: input.engine ?? null, labels: input.participants ?? [] });
}
