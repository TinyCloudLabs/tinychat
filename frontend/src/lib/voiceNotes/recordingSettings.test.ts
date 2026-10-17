import { expect, test } from "bun:test";
import {
  parseRecordingDoc, reconcile, serializeRecordingDoc,
  type LocalState, type RecordingDoc, type SetFields,
} from "./recordingSettings";

const ME = "did:pkh:eip155:1:0xme";
const NOW = 1_000_000;

const local = (fields: SetFields, extra: Partial<LocalState> = {}): LocalState =>
  ({ fields, at: null, owner: null, dirty: [], ...extra });
const doc = (updatedAt: number, fields: SetFields, extra: Record<string, unknown> = {}): RecordingDoc =>
  ({ v: 1, updatedAt, fields, extra });

test("with no document, only explicitly set local values seed it; nothing set writes nothing", () => {
  const seeded = reconcile(local({ stopAfter: "30", uploadAudio: true }), null, ME, NOW);
  expect(seeded.write).toEqual(doc(NOW, { stopAfter: "30", uploadAudio: true }));
  expect(seeded.adopt).toEqual({});
  expect(reconcile(local({}), null, ME, NOW).write).toBeNull();
});

test("an existing document beats a local value that has no stamp, however new the local value feels", () => {
  const plan = reconcile(local({ stopAfter: "15", transcriber: "private-cloud" }), doc(5, { stopAfter: "120" }), ME, NOW);
  expect(plan.adopt).toEqual({ stopAfter: "120" });
  // The field the document never held joins it; it does not overwrite anything.
  expect(plan.write?.fields).toEqual({ stopAfter: "120", transcriber: "private-cloud" });
  expect(plan.write!.updatedAt).toBeGreaterThan(5);
});

test("a newer local edit lays only its edited fields over the document; an older one loses", () => {
  const remote = doc(100, { stopAfter: "60", identifySpeakers: false, uploadAudio: false });
  // This device's cache still holds an old identifySpeakers=true it never edited.
  const cached = { stopAfter: "15", identifySpeakers: true, uploadAudio: false } as const;
  const newer = reconcile(local(cached, { at: 200, owner: ME, dirty: ["stopAfter"] }), remote, ME, NOW);
  expect(newer.write?.fields).toEqual({ stopAfter: "15", identifySpeakers: false, uploadAudio: false });
  expect(newer.write?.updatedAt).toBe(200);
  expect(newer.adopt).toEqual({ identifySpeakers: false });

  const older = reconcile(local(cached, { at: 50, owner: ME, dirty: ["stopAfter"] }), remote, ME, NOW);
  expect(older.write).toBeNull();
  expect(older.adopt).toEqual({ stopAfter: "60", identifySpeakers: false });
});

test("values another account left in this cache neither seed nor win", () => {
  const theirs = local({ stopAfter: "15" }, { at: 500, owner: "did:pkh:eip155:1:0xother", dirty: ["stopAfter"] });
  const empty = reconcile(theirs, null, ME, NOW);
  expect(empty.write).toBeNull();
  expect(empty.claim).toBe(false);
  const withDoc = reconcile(theirs, doc(5, { stopAfter: "120" }), ME, NOW);
  expect(withDoc.write).toBeNull();
  expect(withDoc.adopt).toEqual({ stopAfter: "120" });
});

test("parsing: invalid fields count as unset, unknown keys survive a rewrite, a newer version is left alone", () => {
  const parsed = parseRecordingDoc(JSON.stringify({ v: 1, updatedAt: 7, stopAfter: "99", uploadAudio: true, transcriber: "assemblyai", future: [1] }));
  expect(parsed.kind).toBe("doc");
  if (parsed.kind !== "doc") return;
  // Powerful is not a synced default, whatever a document says.
  expect(parsed.doc.fields).toEqual({ uploadAudio: true });
  expect(JSON.parse(serializeRecordingDoc(parsed.doc))).toEqual({ v: 1, updatedAt: 7, uploadAudio: true, future: [1] });
  expect(parseRecordingDoc(JSON.stringify({ v: 2, updatedAt: 9 })).kind).toBe("newer-version");
  expect(parseRecordingDoc("not json").kind).toBe("none");
  expect(parseRecordingDoc(null).kind).toBe("none");
});
