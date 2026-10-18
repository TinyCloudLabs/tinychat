// The synced recording settings: ONE versioned document in the user's own TinyCloud space (never the backend).
// This file is pure: parsing, serializing and the conflict rule. Storage lives in recordingSettingsSync.ts.

/** When new recordings stop by themselves: minutes, or "off" for the recorder's 3-hour limit. */
export type StopAfter = "15" | "30" | "60" | "120" | "off";
export const STOP_AFTER_VALUES: readonly StopAfter[] = ["15", "30", "60", "120", "off"];
export const DEFAULT_STOP_AFTER: StopAfter = "60";

/** Recording defaults that sync. Powerful ("assemblyai") is never one: its consent stays per device. */
export type SyncedTranscriber = "off" | "on-device" | "private-cloud";
export type SyncedUploadEngine = "private-cloud" | "assemblyai";

export interface RecordingFields {
  transcriber: SyncedTranscriber;
  identifySpeakers: boolean;
  stopAfter: StopAfter;
  uploadAudio: boolean;
  uploadEngine: SyncedUploadEngine;
}
export type RecordingField = keyof RecordingFields;
export const RECORDING_FIELDS: readonly RecordingField[] = ["transcriber", "identifySpeakers", "stopAfter", "uploadAudio", "uploadEngine"];

/** Only the fields that were ever set. A missing field means the default. */
export type SetFields = Partial<RecordingFields>;

export const RECORDING_SETTING_KEY = "recording";
export const RECORDING_DOC_VERSION = 1;

export interface RecordingDoc {
  v: typeof RECORDING_DOC_VERSION;
  /** Epoch ms of the newest change in the document. */
  updatedAt: number;
  fields: SetFields;
  /** Keys this app version does not know, kept so an older app never strips a newer one's additions. */
  extra: Record<string, unknown>;
}

const VALID: { [K in RecordingField]: (value: unknown) => value is RecordingFields[K] } = {
  transcriber: (value): value is SyncedTranscriber => value === "off" || value === "on-device" || value === "private-cloud",
  identifySpeakers: (value): value is boolean => typeof value === "boolean",
  stopAfter: (value): value is StopAfter => STOP_AFTER_VALUES.includes(value as StopAfter),
  uploadAudio: (value): value is boolean => typeof value === "boolean",
  uploadEngine: (value): value is SyncedUploadEngine => value === "private-cloud" || value === "assemblyai",
};

export function isValidField<K extends RecordingField>(field: K, value: unknown): value is RecordingFields[K] {
  return VALID[field](value);
}

export type ParsedRemote =
  | { kind: "none" }
  /** Written by a newer app. Left alone: nothing is adopted from it and nothing overwrites it. */
  | { kind: "newer-version" }
  | { kind: "doc"; doc: RecordingDoc };

/** The stored row as a document. Unreadable text counts as no document; invalid fields count as unset. */
export function parseRecordingDoc(raw: string | null): ParsedRemote {
  if (raw === null) return { kind: "none" };
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return { kind: "none" }; }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { kind: "none" };
  const record = parsed as Record<string, unknown>;
  // Anything but our own version is not ours to overwrite.
  if (record.v !== RECORDING_DOC_VERSION) return { kind: "newer-version" };
  const updatedAt = typeof record.updatedAt === "number" && Number.isFinite(record.updatedAt) ? record.updatedAt : 0;
  const fields: SetFields = {};
  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (key === "v" || key === "updatedAt") continue;
    if ((RECORDING_FIELDS as readonly string[]).includes(key)) {
      const field = key as RecordingField;
      if (isValidField(field, value)) (fields as Record<string, unknown>)[field] = value;
    } else extra[key] = value;
  }
  return { kind: "doc", doc: { v: RECORDING_DOC_VERSION, updatedAt, fields, extra } };
}

export function serializeRecordingDoc(doc: RecordingDoc): string {
  return JSON.stringify({ ...doc.extra, ...doc.fields, v: RECORDING_DOC_VERSION, updatedAt: doc.updatedAt });
}

/** What one account's cache on this device holds: explicitly set fields, plus when they were last synced or edited. */
export interface LocalState {
  fields: SetFields;
  /** Time of the last local edit, or the document's updatedAt after the last adopt or push. Null: never stamped (older than any document). */
  at: number | null;
  /** Fields edited here since the last adopt or push. */
  dirty: readonly RecordingField[];
  /** This device's recording default is Powerful, which never syncs: no document value replaces it. */
  powerful: boolean;
}

export interface ReconcilePlan {
  /** Fields to put into this device's cache (and the capture engine), already differing from what it holds. */
  adopt: SetFields;
  /** The document to store, or null when the space already holds this device's view. */
  write: RecordingDoc | null;
  /** What the local stamp becomes once the plan is applied. */
  stamp: number | null;
}

/**
 * The conflict rule. Newest updatedAt wins, whole document: a device whose stamp is newer than the document lays only
 * the fields it edited over it; otherwise the document is adopted. A local value without a stamp counts as older. An
 * explicitly set local field the document lacks is added to it, so an existing per-device value joins; a field that is
 * unset locally never overwrites anything. The caller has already dropped a cache another account left behind.
 */
export function reconcile(local: LocalState, remote: RecordingDoc | null, now: number): ReconcilePlan {
  const mine = local.fields;
  const localAt = local.at;

  if (!remote) {
    if (RECORDING_FIELDS.every((field) => mine[field] === undefined)) return { adopt: {}, write: null, stamp: local.at };
    const updatedAt = Math.max(localAt ?? now, 1);
    return { adopt: {}, write: { v: RECORDING_DOC_VERSION, updatedAt, fields: { ...mine }, extra: {} }, stamp: updatedAt };
  }

  const localNewer = localAt !== null && localAt > remote.updatedAt;
  const merged: SetFields = { ...remote.fields };
  if (localNewer) {
    for (const field of local.dirty) if (mine[field] !== undefined) (merged as Record<string, unknown>)[field] = mine[field];
  }
  // Fields the document has never held and this device explicitly has: added, never overwriting.
  for (const field of RECORDING_FIELDS) if (merged[field] === undefined && mine[field] !== undefined) (merged as Record<string, unknown>)[field] = mine[field];

  const changed = !RECORDING_FIELDS.every((field) => merged[field] === remote.fields[field]);
  // A pending edit keeps its own time; an addition is stamped after everything the document has seen.
  const updatedAt = !changed ? remote.updatedAt : localNewer ? localAt : Math.max(remote.updatedAt + 1, now);
  const adopt: SetFields = {};
  for (const field of RECORDING_FIELDS) {
    if (field === "transcriber" && local.powerful) continue;
    if (merged[field] !== undefined && merged[field] !== local.fields[field]) (adopt as Record<string, unknown>)[field] = merged[field];
  }
  return {
    adopt,
    write: changed ? { v: RECORDING_DOC_VERSION, updatedAt, fields: merged, extra: remote.extra } : null,
    stamp: updatedAt,
  };
}
