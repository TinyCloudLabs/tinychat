// Names in the call and who spoke when, on a voice-note row: the writes and the read that callNames.ts runs. A module of
// their own, loaded with callNames.ts, so the entry chunk the web app boots from does not carry them (TC-2882);
// voiceNoteRows.ts still names them. Each statement runs on the space lane through voiceNoteRows.ts.
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { parseCallParticipants, SUGGESTED_SPEAKER, type CallParticipants } from "@/capture/library/callParticipants";
import type { SpeakerSuggestion } from "@/capture/library/speakerNames";
import { isCallPersonLabel } from "@/capture/library/speakerNamesCopy";
import { execute, query } from "./voiceNoteRows";

/**
 * Names in the call: puts the people the desktop app read from the meeting window (`call_participants`) on a Mac
 * recording's row, with the name suggested for "Them" when there is one. One statement, applied by the database to
 * the metadata as it is when it runs: it writes only while the row has no `call_participants` (so it runs once,
 * however often it is retried), and the suggestion goes into `speaker_names` only while "Them" has no name there, so
 * a name the user gave is never replaced, even one saved a moment before. "written" when this call wrote them; "kept"
 * when the row already had them; "missing" when there is no such voice-note row of a recording of both sides.
 */
export async function writeCallParticipants(tcw: TinyCloudWeb, rowId: string, participants: CallParticipants,
  suggestion: SpeakerSuggestion | null, checkpoint: () => void = () => undefined): Promise<"written" | "kept" | "missing"> {
  const m = "CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END";
  const withoutName = JSON.stringify({ call_participants: participants });
  const withName = suggestion === null ? withoutName : JSON.stringify({ call_participants: participants,
    speaker_suggestions: { [SUGGESTED_SPEAKER]: suggestion }, speaker_names: { [SUGGESTED_SPEAKER]: suggestion.name } });
  const changes = await execute(tcw, `UPDATE connector_meeting SET metadata = json_patch(${m},
      CASE WHEN json_extract(${m}, '$.speaker_names.${SUGGESTED_SPEAKER}') IS NULL THEN ? ELSE ? END), updated_at = ?
    WHERE id = ? AND source = 'exo-voice-note' AND json_extract(${m}, '$.capture.channels') = 2
      AND json_extract(${m}, '$.call_participants') IS NULL`,
  [withName, withoutName, new Date().toISOString(), rowId], checkpoint);
  if (changes > 0) return "written";
  // The same guarded metadata as the write: AND does not stop at a false json_valid, and json_extract throws on
  // text that is not JSON.
  const [row] = await query(tcw, `SELECT json_extract(${m}, '$.call_participants') IS NOT NULL
    FROM connector_meeting WHERE id = ? AND source = 'exo-voice-note'`, [rowId], checkpoint);
  return row !== undefined && Number(row[0]) === 1 ? "kept" : "missing";
}

/**
 * Who spoke when: the name suggested for each "Them N" label of a Mac call recording's row, one statement per label,
 * applied by the database to the metadata as it is when it runs. A label is written once (`speaker_suggestions_made`
 * records it, however often this is retried); its suggestion goes into `speaker_names` only while the label has no
 * name there, so a name the user gave is never replaced; a label in `ended` (the user acted on its suggestion while
 * the note was only on this device) is recorded without a suggestion. Returns how many labels this call wrote.
 */
export async function writeCallSpeakerSuggestions(tcw: TinyCloudWeb, rowId: string, suggestions: Readonly<Record<string, SpeakerSuggestion>>,
  ended: readonly string[], checkpoint: () => void = () => undefined): Promise<number> {
  const m = "CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END";
  let written = 0;
  for (const [label, suggestion] of Object.entries(suggestions)) {
    // Labels are "Them N", so the paths need no escaping; anything else is not written.
    if (!isCallPersonLabel(label)) continue;
    const made = { speaker_suggestions_made: { [label]: suggestion.at } };
    const withoutName = JSON.stringify(made);
    const withName = ended.includes(label) ? withoutName
      : JSON.stringify({ ...made, speaker_suggestions: { [label]: suggestion }, speaker_names: { [label]: suggestion.name } });
    written += await execute(tcw, `UPDATE connector_meeting SET metadata = json_patch(${m},
        CASE WHEN json_extract(${m}, ?) IS NULL THEN ? ELSE ? END), updated_at = ?
      WHERE id = ? AND source = 'exo-voice-note' AND json_extract(${m}, '$.capture.channels') = 2
        AND json_extract(${m}, ?) IS NULL`,
    [`$.speaker_names."${label}"`, withName, withoutName, new Date().toISOString(), rowId, `$.speaker_suggestions_made."${label}"`],
    checkpoint) > 0 ? 1 : 0;
  }
  return written;
}

/** The call participants a voice-note row holds, or null (none, not in the agreed shape, or no such row). */
export async function readRowCallParticipants(tcw: TinyCloudWeb, rowId: string,
  checkpoint: () => void = () => undefined): Promise<CallParticipants | null> {
  const m = "CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END";
  const [row] = await query(tcw, `SELECT json_extract(${m}, '$.call_participants') FROM connector_meeting
    WHERE id = ? AND source = 'exo-voice-note'`, [rowId], checkpoint);
  if (row === undefined || typeof row[0] !== "string") return null;
  try { return parseCallParticipants(JSON.parse(row[0])); } catch { return null; }
}
