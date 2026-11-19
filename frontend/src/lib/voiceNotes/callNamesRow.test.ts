import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { parseCallParticipants, suggestSpeakerNames } from "@/capture/library/callParticipants";
import { patchRowSpeakerName, writeCallParticipants } from "./voiceNoteRows";

// Names in the call, as the database applies them: the one statement that puts the call's people (and the
// suggestion for Them) on a recording's row, against the rename write (patchRowSpeakerName).

const AT = "2026-11-18T18:20:00.000Z";
const ONE_ON_ONE = parseCallParticipants({ v: 1, source: "call_window", app: "google-meet", truncated: false,
  people: [{ id: "p1", name: "Robin Sample", self: true }, { id: "p2", name: "Alex Example" }] })!;
const GROUP = parseCallParticipants({ v: 1, source: "call_window", app: "zoom", truncated: false,
  people: [{ id: "p1", name: "Robin Sample", self: true }, { id: "p2", name: "Alex Example" }, { id: "p3", name: "Dana Lee" }] })!;
const suggestionFor = (participants: typeof ONE_ON_ONE) => suggestSpeakerNames(participants, AT).Them ?? null;
const STEREO = { capture: { platform: "tauri", channels: 2 }, transcription_outcome: "pending" };

/** A space with one row; `before` runs inside the next write, just before its statement (another writer racing it). */
function space(metadata: Record<string, unknown> | string = STEREO, source = "exo-voice-note") {
  const sqlite = new Database(":memory:");
  sqlite.run("CREATE TABLE connector_meeting (id TEXT PRIMARY KEY, source TEXT, metadata TEXT, updated_at TEXT)");
  sqlite.run("INSERT INTO connector_meeting VALUES ('vn-rec-1', ?, ?, '')", [source, typeof metadata === "string" ? metadata : JSON.stringify(metadata)]);
  let before: (() => void) | null = null;
  const writes: string[] = [];
  /** The row's metadata text as each write statement left it, in order. */
  const afterWrites: string[] = [];
  const raw = () => (sqlite.query("SELECT metadata FROM connector_meeting WHERE id = 'vn-rec-1'").get() as { metadata: string }).metadata;
  const tcw = { did: "did:test", spaceId: "did:test", sql: { db: () => ({
    query: async (sql: string, params: never[]) => {
      try { return { ok: true, data: { rows: sqlite.query(sql).values(...params) } }; }
      catch (error) { return { ok: false, error: { code: "SQL_ERROR", message: String(error) } }; }
    },
    execute: async (sql: string, params: never[]) => {
      const race = before;
      before = null;
      race?.();
      writes.push(sql);
      try {
        const { changes } = sqlite.run(sql, params);
        afterWrites.push(raw());
        return { ok: true, data: { changes } };
      } catch (error) { return { ok: false, error: { code: "SQL_ERROR", message: String(error) } }; }
    },
  }) } } as unknown as TinyCloudWeb;
  const stored = () => JSON.parse(raw()) as Record<string, unknown>;
  /** Another device renames a speaker the way the app does, straight in the database. */
  const renameElsewhere = (label: string, name: string) => sqlite.run(
    "UPDATE connector_meeting SET metadata = json_patch(metadata, ?) WHERE id = 'vn-rec-1'", [JSON.stringify({ speaker_names: { [label]: name } })]);
  return { tcw, sqlite, stored, raw, writes, afterWrites, renameElsewhere, raceNextWrite: (run: () => void) => { before = run; } };
}

test("a 1:1 call puts the people, the suggestion and the name for Them on the row in one write", async () => {
  const { tcw, stored, writes } = space();
  expect(await writeCallParticipants(tcw, "vn-rec-1", ONE_ON_ONE, suggestionFor(ONE_ON_ONE))).toBe("written");
  expect(writes).toHaveLength(1);
  expect(stored()).toEqual({ ...STEREO, call_participants: ONE_ON_ONE,
    speaker_names: { Them: "Alex Example" },
    speaker_suggestions: { Them: { name: "Alex Example", source: "call_window", confidence: "high", reason: "one_other_participant", person: "p2", at: AT } } });
});

test("a name the user already gave Them stays: the people are written, the suggestion is not", async () => {
  const { tcw, stored } = space({ ...STEREO, speaker_names: { Them: "Alex", Me: "Robin" } });
  expect(await writeCallParticipants(tcw, "vn-rec-1", ONE_ON_ONE, suggestionFor(ONE_ON_ONE))).toBe("written");
  expect(stored()).toEqual({ ...STEREO, speaker_names: { Them: "Alex", Me: "Robin" }, call_participants: ONE_ON_ONE });
});

test("a rename that lands after the names were read and before they are written is never replaced", async () => {
  const { tcw, stored, renameElsewhere, raceNextWrite } = space();
  // The suggestion is worked out first; the user names Them on another device before the statement runs.
  const suggestion = suggestionFor(ONE_ON_ONE);
  raceNextWrite(() => renameElsewhere("Them", "Alexandra"));
  expect(await writeCallParticipants(tcw, "vn-rec-1", ONE_ON_ONE, suggestion)).toBe("written");
  expect(stored().speaker_names).toEqual({ Them: "Alexandra" });
  expect(stored().speaker_suggestions).toBeUndefined();
  expect(stored().call_participants).toEqual(ONE_ON_ONE);
});

test("a rename after the suggestion replaces it and ends the suggestion in the same write", async () => {
  const { tcw, stored } = space({ ...STEREO, speaker_names: { Me: "Robin" } });
  await writeCallParticipants(tcw, "vn-rec-1", ONE_ON_ONE, suggestionFor(ONE_ON_ONE));
  await patchRowSpeakerName(tcw, "vn-rec-1", "Them", "Alexander");
  expect(stored()).toEqual({ ...STEREO, call_participants: ONE_ON_ONE, speaker_names: { Me: "Robin", Them: "Alexander" } });
});

test("keeping the suggested name writes it as the user's own: the name stays, the suggestion goes", async () => {
  const { tcw, stored } = space();
  await writeCallParticipants(tcw, "vn-rec-1", ONE_ON_ONE, suggestionFor(ONE_ON_ONE));
  await patchRowSpeakerName(tcw, "vn-rec-1", "Them", "Alex Example");
  expect(stored()).toEqual({ ...STEREO, call_participants: ONE_ON_ONE, speaker_names: { Them: "Alex Example" } });
});

test("Go back to Them removes the suggested name and its suggestion, and nothing else", async () => {
  const { tcw, stored } = space();
  await writeCallParticipants(tcw, "vn-rec-1", ONE_ON_ONE, suggestionFor(ONE_ON_ONE));
  await patchRowSpeakerName(tcw, "vn-rec-1", "Them", null);
  expect(stored()).toEqual({ ...STEREO, call_participants: ONE_ON_ONE });
});

test("it writes once: a retry, even after the user cleared the name, brings nothing back", async () => {
  const { tcw, stored } = space();
  expect(await writeCallParticipants(tcw, "vn-rec-1", ONE_ON_ONE, suggestionFor(ONE_ON_ONE))).toBe("written");
  await patchRowSpeakerName(tcw, "vn-rec-1", "Them", null);
  const after = stored();
  expect(await writeCallParticipants(tcw, "vn-rec-1", ONE_ON_ONE, suggestionFor(ONE_ON_ONE))).toBe("kept");
  expect(stored()).toEqual(after);
  // A retry with other people does not replace the first evidence either.
  expect(await writeCallParticipants(tcw, "vn-rec-1", GROUP, null)).toBe("kept");
  expect(stored().call_participants).toEqual(ONE_ON_ONE);
});

test("two other people in the call: the people are written and nothing is suggested", async () => {
  const { tcw, stored } = space();
  expect(suggestionFor(GROUP)).toBeNull();
  expect(await writeCallParticipants(tcw, "vn-rec-1", GROUP, suggestionFor(GROUP))).toBe("written");
  expect(stored()).toEqual({ ...STEREO, call_participants: GROUP });
});

test("only the voice-note row of a recording of both sides takes them", async () => {
  const mono = space({ capture: { platform: "tauri", channels: 1 } });
  expect(await writeCallParticipants(mono.tcw, "vn-rec-1", ONE_ON_ONE, suggestionFor(ONE_ON_ONE))).toBe("missing");
  expect(mono.stored()).toEqual({ capture: { platform: "tauri", channels: 1 } });
  const upload = space(STEREO, "exo-upload");
  expect(await writeCallParticipants(upload.tcw, "vn-rec-1", ONE_ON_ONE, suggestionFor(ONE_ON_ONE))).toBe("missing");
  expect(upload.stored()).toEqual(STEREO);
  const { tcw } = space();
  expect(await writeCallParticipants(tcw, "vn-other", ONE_ON_ONE, suggestionFor(ONE_ON_ONE))).toBe("missing");
});

test("a rename on a row without suggestions writes the names alone, as before", async () => {
  const { tcw, stored, afterWrites } = space({ capture: "upload" }, "exo-upload");
  await patchRowSpeakerName(tcw, "vn-rec-1", "Speaker A", "Ana");
  // Read as the first statement left it, before the cleanup could hide it: the write itself makes no
  // `speaker_suggestions` on a row that has none.
  expect(JSON.parse(afterWrites[0]!)).toEqual({ capture: "upload", speaker_names: { "Speaker A": "Ana" } });
  expect(stored()).toEqual({ capture: "upload", speaker_names: { "Speaker A": "Ana" } });
  await patchRowSpeakerName(tcw, "vn-rec-1", "Speaker A", null);
  expect(JSON.parse(afterWrites[2]!)).toEqual({ capture: "upload", speaker_names: {} });
  expect(stored()).toEqual({ capture: "upload" });
});

test("a row whose metadata is not JSON is refused without an error, and left as it is", async () => {
  for (const broken of ["{oops", ""]) {
    const { tcw, raw } = space(broken);
    expect(await writeCallParticipants(tcw, "vn-rec-1", ONE_ON_ONE, suggestionFor(ONE_ON_ONE))).toBe("missing");
    expect(raw()).toBe(broken);
  }
});

test("a rename of another label leaves Them's suggestion as it is", async () => {
  const { tcw, stored } = space();
  await writeCallParticipants(tcw, "vn-rec-1", ONE_ON_ONE, suggestionFor(ONE_ON_ONE));
  await patchRowSpeakerName(tcw, "vn-rec-1", "Me", "Robin");
  expect(stored().speaker_names).toEqual({ Them: "Alex Example", Me: "Robin" });
  expect(Object.keys(stored().speaker_suggestions as object)).toEqual(["Them"]);
});
