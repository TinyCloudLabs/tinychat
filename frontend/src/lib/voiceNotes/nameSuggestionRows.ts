// A voice note's suggested speaker names on its row (`metadata.speaker_name_suggestions`): the writes a naming run
// and a Dismiss make. A module of their own, loaded with the naming runner and the note page, so the entry chunk
// the web app boots from carries neither them nor the naming modules they name (TC-2882). Each statement runs on
// the space lane through voiceNoteRows.ts.
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { NAME_SUGGESTIONS_KEY, type NameSuggestions } from "@/lib/speakerNaming/nameSuggestions";
import { execute } from "./voiceNoteRows";

/**
 * A naming run's result on a voice note: `metadata.speaker_name_suggestions`, written whole (a merge patch would
 * keep the labels of an older run). An automatic run writes only where the stored value is not already of this
 * transcript revision, so two devices that both ran write once and a Dismiss made meanwhile stays. The menu's
 * "Suggest names" (`replace`) writes over whatever is stored: the user asked again. `speaker_names` is not touched.
 * `updated_at` moves, as for a rename: `writeRecordingTitle` writes the whole metadata back only where it has not
 * moved, and would otherwise erase a suggestion saved between its read and its write. The Library neither orders
 * by it nor shows it. False when nothing was written.
 */
export async function writeRowNameSuggestions(tcw: TinyCloudWeb, rowId: string, suggestions: NameSuggestions, replace: boolean,
  checkpoint: () => void = () => undefined): Promise<boolean> {
  const changes = await execute(tcw,
    `UPDATE connector_meeting SET metadata = json_set(metadata, '$.${NAME_SUGGESTIONS_KEY}', json(?)), updated_at = ?
      WHERE id = ? AND source = 'exo-voice-note' AND json_valid(metadata)${replace ? "" : ` AND COALESCE(json_extract(metadata, '$.${NAME_SUGGESTIONS_KEY}.hash'), '') != ?`}`,
    [JSON.stringify(suggestions), new Date().toISOString(), rowId, ...(replace ? [] : [suggestions.hash])], checkpoint);
  return changes > 0;
}

/**
 * The labels whose suggestion the user dismissed (`metadata.speaker_name_suggestions.dismissed`), set only where the
 * stored suggestions are still those of the transcript revision the note showed (`hash`): after a new run the
 * labels are another transcript's, and a late Dismiss does nothing. False when nothing was written.
 */
export async function dismissRowNameSuggestions(tcw: TinyCloudWeb, rowId: string, hash: string, dismissed: readonly string[],
  checkpoint: () => void = () => undefined): Promise<boolean> {
  const changes = await execute(tcw,
    `UPDATE connector_meeting SET metadata = json_set(metadata, '$.${NAME_SUGGESTIONS_KEY}.dismissed', json(?)), updated_at = ?
      WHERE id = ? AND json_valid(metadata) AND json_extract(metadata, '$.${NAME_SUGGESTIONS_KEY}.hash') = ?`,
    [JSON.stringify(dismissed), new Date().toISOString(), rowId, hash], checkpoint);
  return changes > 0;
}
