import { expect, test } from "bun:test";
import {
  parseRecordingDoc, reconcile, serializeRecordingDoc,
  type LocalState, type RecordingDoc, type SetFields,
} from "./recordingSettings";

const NOW = 1_000_000;

const local = (fields: SetFields, extra: Partial<LocalState> = {}): LocalState =>
  ({ fields, at: null, owner: null, dirty: [], powerful: false, ...extra });
const doc = (updatedAt: number, fields: SetFields, extra: Record<string, unknown> = {}): RecordingDoc =>
  ({ v: 1, updatedAt, fields, extra });

test("with no document, only explicitly set local values seed it; nothing set writes nothing", () => {
  const seeded = reconcile(local({ stopAfter: "30", uploadAudio: true }), null, NOW);
  expect(seeded.write).toEqual(doc(NOW, { stopAfter: "30", uploadAudio: true }));
  expect(seeded.adopt).toEqual({});
  expect(reconcile(local({}), null, NOW).write).toBeNull();
});

test("an existing document beats a local value that has no stamp, however new the local value feels", () => {
  const plan = reconcile(local({ stopAfter: "15", transcriber: "private-cloud" }), doc(5, { stopAfter: "120" }), NOW);
  expect(plan.adopt).toEqual({ stopAfter: "120" });
  // The field the document never held joins it; it does not overwrite anything.
  expect(plan.write?.fields).toEqual({ stopAfter: "120", transcriber: "private-cloud" });
  expect(plan.write!.updatedAt).toBeGreaterThan(5);
});

test("a newer local edit lays only its edited fields over the document; an older one loses", () => {
  const remote = doc(100, { stopAfter: "60", identifySpeakers: false, uploadAudio: false });
  // This device's cache still holds an old identifySpeakers=true it never edited.
  const cached = { stopAfter: "15", identifySpeakers: true, uploadAudio: false } as const;
  const newer = reconcile(local(cached, { at: 200, owner: "a", dirty: ["stopAfter"] }), remote, NOW);
  expect(newer.write?.fields).toEqual({ stopAfter: "15", identifySpeakers: false, uploadAudio: false });
  expect(newer.write?.updatedAt).toBe(200);
  expect(newer.adopt).toEqual({ identifySpeakers: false });

  const older = reconcile(local(cached, { at: 50, owner: "a", dirty: ["stopAfter"] }), remote, NOW);
  expect(older.write).toBeNull();
  expect(older.adopt).toEqual({ stopAfter: "60", identifySpeakers: false });
});

test("a device whose recording default is Powerful never has it replaced by a document value", () => {
  const plan = reconcile(local({ stopAfter: "15" }, { powerful: true }), doc(5, { transcriber: "private-cloud", stopAfter: "120" }), NOW);
  expect(plan.adopt).toEqual({ stopAfter: "120" });
  expect(plan.write).toBeNull();
});

test("parsing: invalid fields count as unset, unknown keys survive a rewrite, a version that is not ours is left alone", () => {
  const parsed = parseRecordingDoc(JSON.stringify({ v: 1, updatedAt: 7, stopAfter: "99", uploadAudio: true, transcriber: "assemblyai", future: [1] }));
  expect(parsed.kind).toBe("doc");
  if (parsed.kind !== "doc") return;
  // Powerful is not a synced default, whatever a document says.
  expect(parsed.doc.fields).toEqual({ uploadAudio: true });
  expect(JSON.parse(serializeRecordingDoc(parsed.doc))).toEqual({ v: 1, updatedAt: 7, uploadAudio: true, future: [1] });
  expect(parseRecordingDoc(JSON.stringify({ v: 2, updatedAt: 9 })).kind).toBe("newer-version");
  expect(parseRecordingDoc(JSON.stringify({ v: "1", updatedAt: 9 })).kind).toBe("newer-version");
  expect(parseRecordingDoc("not json").kind).toBe("none");
  expect(parseRecordingDoc(null).kind).toBe("none");
});
