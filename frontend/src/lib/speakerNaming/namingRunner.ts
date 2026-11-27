// Runs the naming of a voice note's speakers and stores what it finds as suggestions on the note's row.
//
// One runner per signed-in space (CaptureSurface owns it). A run is asked for when a voice note changes or is
// opened (`consider`: it runs only if "Suggest speaker names" is on, the note qualifies and has no suggestions for
// the transcript it now shows) or by the note menu's "Suggest names" (`suggest`: it always runs on a note that
// qualifies). At most one run per note at a time.
//
// Which notes qualify: a voice note whose committed transcript is `transcribed` by Private or Powerful (never an
// on-device or a pasted one), with at least one label a name may be suggested for, and whose request fits the
// API's body limit. A note that does not qualify gets no run and nothing is written.
//
// A run reads the transcript and the candidate names from the space, asks the model NAMING_READINGS times, and
// writes ONLY `metadata.speaker_name_suggestions` (one UPDATE). It never writes `speaker_names`: a suggestion
// becomes a name when the user accepts it. A run with no names still writes an empty result, so the note is not
// read again. A failed run writes nothing and is tried again on the next change or opening, once per note in a
// session. It logs nothing: no transcript text, no model text, no error message.
import { CALENDAR_LINK_KEY, calendarLinkInviteeNames, parseCalendarLink } from "@tinyboilerplate/core";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { captureEvents } from "@/capture/captureEvents";
import { CALL_PARTICIPANTS_KEY, parseCallParticipants } from "@/capture/library/callParticipants";
import { EARLIER_SPEAKER_NAMES_KEY } from "@/capture/library/speakerNames";
import { calendarLinkingEnabled } from "@/lib/calendarLink/calendarLinkFeature";
import { CONNECTORS_SQL_DB_NAME } from "@/lib/connectors/connectorStore";
import { readTranscript } from "@/lib/connectors/meetingExplorer";
import { scheduledSpace } from "@/lib/spaceQueue";
import { readTranscriptCommit } from "@/lib/voiceNotes/voiceNoteCommits";
import { writeRowNameSuggestions } from "@/lib/voiceNotes/nameSuggestionRows";
import { VOICE_NOTE_SOURCE } from "@/lib/voiceNotes/voiceNoteStore";

import { readCandidateNames } from "./candidateNames";
import { NAME_SUGGESTIONS_KEY, NAMED_ENGINES } from "./nameSuggestions";
import { MAX_NAMING_REQUEST_BYTES, NAMING_MODEL, namingRequestBytes, type ReadNames } from "./namingChat";
import { buildNamingPrompt, suggestibleLabels } from "./namingPrompt";
import { agreeOnNames } from "./parseNaming";

/** A note's automatic runs that may fail in one session: the first and one more. */
const AUTOMATIC_ATTEMPTS = 2;

export interface NamingRunnerDeps {
  /** The signed-in account's space. Reads take the Library's queue (scheduledSpace); the write takes the space write lane. */
  tcw: TinyCloudWeb;
  read: ReadNames;
  /** The "Suggest speaker names" setting. A setting that cannot be read starts no run: the next change asks again. */
  automatic: () => Promise<boolean>;
  /** Called when a run's model calls have returned: they have spent credits. */
  onSpent?: () => void;
}

export interface NamingRunner {
  /** A voice note changed, or was opened: name its speakers unless that is off, done, or not for this note. */
  consider: (sourceId: string) => void;
  /** The user's "Suggest names": run now, and replace what is stored (dismissed suggestions included). */
  suggest: (sourceId: string) => void;
  /** Stop every run (another account, or unmount). */
  cancelAll: () => void;
  /** Resolves once no run is going. */
  idle: () => Promise<void>;
}

interface Job {
  controller: AbortController;
  /** The user asked for this run; an automatic one becomes the user's when "Suggest names" is chosen while it runs. */
  menu: boolean;
  /** The note changed while this run was going: it is considered again afterwards. */
  again: boolean;
}

/**
 * What a run needs of the note's row. The row's whole `metadata` is never read: it can hold the transcript's text.
 * Its calendar link is small (an event's title and times and at most 100 invitees).
 */
const NOTE_QUERY = `SELECT id, started_at, duration_secs, json_extract(metadata, '$.capture'),
    json_extract(metadata, '$.${NAME_SUGGESTIONS_KEY}.hash'), json_extract(metadata, '$.${EARLIER_SPEAKER_NAMES_KEY}'),
    json_extract(metadata, '$.${CALL_PARTICIPANTS_KEY}'), json_extract(metadata, '$.${CALENDAR_LINK_KEY}')
  FROM connector_meeting WHERE source = '${VOICE_NOTE_SOURCE}' AND source_id = ? AND json_valid(metadata)`;

/** A list or an object as `json_extract` returns it (its JSON text); null when there is none or it cannot be read. */
function extracted(cell: unknown): unknown {
  try { return typeof cell === "string" ? JSON.parse(cell) as unknown : null; } catch { return null; }
}

/** The row's `earlier_speaker_names`. */
function earlierNames(cell: unknown): string[] {
  const list = extracted(cell);
  return Array.isArray(list) ? list.filter((name): name is string => typeof name === "string") : [];
}

export function createNamingRunner(deps: NamingRunnerDeps): NamingRunner {
  const space = scheduledSpace(deps.tcw);
  const jobs = new Map<string, Job>();
  const runs = new Set<Promise<void>>();
  /** Automatic runs that failed, by note. */
  const failures = new Map<string, number>();
  /** The transcript revision for which a note needs no further automatic run in this session: it got suggestions, or does not qualify. */
  const settled = new Map<string, string>();
  /** The model calls were refused for credits: no automatic run asks again in this session. */
  let refused = false;

  const run = async (sourceId: string, job: Job): Promise<void> => {
    const current = () => jobs.get(sourceId) === job;
    let failed = false;
    /** An automatic run found nothing to do: the note has its suggestions, or the setting is off. */
    let nothingToDo = false;
    try {
      const rows = await space.sql.db(CONNECTORS_SQL_DB_NAME).query(NOTE_QUERY, [sourceId]);
      if (!rows.ok) throw new Error(rows.error.message);
      const row = rows.data.rows[0] as unknown[] | undefined;
      if (!current() || !row || row[3] === "pasted") return;
      const commit = await readTranscriptCommit(space, sourceId);
      if (!current() || !commit || commit.outcome !== "transcribed" || !NAMED_ENGINES.has(commit.engine)) return;
      if (!job.menu) {
        nothingToDo = row[4] === commit.hash || settled.get(sourceId) === commit.hash || !await deps.automatic().catch(() => false);
        if (nothingToDo || !current()) return;
      }
      const transcript = await readTranscript(space, VOICE_NOTE_SOURCE, sourceId, commit.bodyKey);
      if (!current()) return;
      if (transcript.status !== "ok") throw new Error("The transcript could not be read");
      const eligible = suggestibleLabels(transcript.sentences);
      if (eligible.size === 0) {
        settled.set(sourceId, commit.hash);
        return;
      }
      const candidates = await readCandidateNames(space, {
        // The people of this call, as the names in the call read them (the same reader, so the same cleaning).
        call: parseCallParticipants(extracted(row[6]))?.people.map((person) => person.name) ?? [],
        // The people invited to the linked event, by display name: of the link nothing else reaches the model.
        invited: calendarLinkingEnabled() ? calendarLinkInviteeNames(parseCalendarLink(extracted(row[7]))) : [],
        earlier: earlierNames(row[5]),
        startedAt: typeof row[1] === "string" ? row[1] : null,
        durationSecs: typeof row[2] === "number" ? row[2] : null,
      });
      if (!current()) return;
      const prompt = buildNamingPrompt(transcript.sentences, candidates);
      if (namingRequestBytes(prompt.messages) > MAX_NAMING_REQUEST_BYTES) {
        settled.set(sourceId, commit.hash);
        return;
      }
      const { replies, paywall } = await deps.read(prompt.messages, job.controller.signal);
      deps.onSpent?.();
      if (paywall) refused = true;
      if (!current()) return;
      const outcome = agreeOnNames(replies, prompt, candidates, eligible);
      if (!outcome.ok) throw new Error("Too few readings");
      await writeRowNameSuggestions(deps.tcw, String(row[0]),
        { hash: commit.hash, model: NAMING_MODEL, at: new Date().toISOString(), names: outcome.names, dismissed: [] }, job.menu);
      settled.set(sourceId, commit.hash);
      // The open note reads its row again. A listener that asks the runner about the note again ends at the hash.
      captureEvents.emit("library-changed", { source: VOICE_NOTE_SOURCE, sourceId });
    } catch {
      failed = true;
    } finally {
      if (current()) {
        jobs.delete(sourceId);
        if (failed && !job.menu) failures.set(sourceId, (failures.get(sourceId) ?? 0) + 1);
        // "Suggest names" was chosen while an automatic run was finding nothing to do: it runs after all.
        if (nothingToDo && job.menu) begin(sourceId, true);
        else if (job.again) consider(sourceId);
      }
    }
  };

  const begin = (sourceId: string, menu: boolean) => {
    const job: Job = { controller: new AbortController(), menu, again: false };
    jobs.set(sourceId, job);
    const going = run(sourceId, job).finally(() => runs.delete(going));
    runs.add(going);
  };

  const consider = (sourceId: string) => {
    const job = jobs.get(sourceId);
    if (job) { job.again = true; return; }
    if (refused || (failures.get(sourceId) ?? 0) >= AUTOMATIC_ATTEMPTS) return;
    begin(sourceId, false);
  };

  return {
    consider,
    suggest: (sourceId) => {
      const job = jobs.get(sourceId);
      if (job) job.menu = true;
      else begin(sourceId, true);
    },
    cancelAll: () => {
      for (const job of jobs.values()) job.controller.abort();
      jobs.clear();
    },
    idle: async () => { while (runs.size > 0) await Promise.all(runs); },
  };
}
