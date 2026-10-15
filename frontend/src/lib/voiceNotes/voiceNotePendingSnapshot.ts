import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { CONNECTORS_KV_PREFIX } from "../connectors/connectorStore";
import { currentAccountGeneration, isAccountWorkAllowed, type AccountContext } from "./accountContext";
import type { VoiceNoteRecording } from "./nativeVoiceNotes";

const KEY = `${CONNECTORS_KV_PREFIX}/voice-note-pending-snapshot`;
const INSTALL_KEY = "exo.voiceNotes.pendingSnapshotInstallId";
const HEARTBEAT_MS = 50 * 60_000;
const STALE_MS = 90 * 60_000;
let sessionInstallId: string | null = null;
const inventoryFailures = new Set<string>();
const accountKey = (ctx: AccountContext) => `${ctx.did}:${ctx.spaceId}:${ctx.generation}`;

export interface VoiceNotePendingProjection {
  pending_row: number;
  pending_transcript: number;
  pending_decode: number;
  oldest_started_at: string | null;
}
export interface VoiceNotePendingSnapshot extends VoiceNotePendingProjection {
  version: 1;
  install_id: string;
  observed_at: string;
  checked_at: string;
  changed_at: string;
}
export interface VoiceNotePendingRead {
  status: "absent" | "unknown" | "stale" | "fresh";
  snapshot: VoiceNotePendingSnapshot | null;
  oldestAgeMs: number | null;
}

export function voiceNoteInstallId(): string {
  if (sessionInstallId) return sessionInstallId;
  try {
    const stored = localStorage.getItem(INSTALL_KEY);
    if (stored && /^[a-f\d-]{36}$/i.test(stored)) return sessionInstallId = stored;
  } catch { /* Private browsing may not expose storage. */ }
  sessionInstallId = crypto.randomUUID();
  try { localStorage.setItem(INSTALL_KEY, sessionInstallId); } catch { /* This session still has one ID. */ }
  return sessionInstallId;
}

export function projectVoiceNotePending(notes: readonly VoiceNoteRecording[], did: string): VoiceNotePendingProjection {
  let pendingRow = 0;
  let pendingTranscript = 0;
  let pendingDecode = 0;
  let oldest = Infinity;
  for (const note of notes) {
    if (note.owner !== did || note.ownerUnknown || note.legacyImport) continue;
    const row = !note.ledger?.audio.rowId;
    const decode = note.stt && ["queued", "waiting_for_model", "running"].includes(note.stt.state);
    const transcript = note.stt?.state === "done" && (note.ledger?.transcriptSync?.state !== "saved"
      || (note.stt.rerunRev ?? 0) > (note.ledger?.transcriptSync?.rev ?? 0));
    if (row) pendingRow++;
    if (decode) pendingDecode++;
    if (transcript) pendingTranscript++;
    if ((row || decode || transcript) && Number.isFinite(note.startedAt)) oldest = Math.min(oldest, note.startedAt);
  }
  return { pending_row: pendingRow, pending_transcript: pendingTranscript, pending_decode: pendingDecode,
    oldest_started_at: Number.isFinite(oldest) ? new Date(oldest).toISOString() : null };
}

export function markVoiceNoteInventoryUnknown(ctx: AccountContext): void {
  inventoryFailures.add(accountKey(ctx));
}

function parseSnapshot(raw: unknown): VoiceNotePendingSnapshot | null {
  try {
    const value: unknown = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const row = value as Record<string, unknown>;
    if (row.version !== 1 || typeof row.install_id !== "string") return null;
    for (const field of ["observed_at", "checked_at", "changed_at"] as const)
      if (typeof row[field] !== "string" || !Number.isFinite(Date.parse(row[field]))) return null;
    for (const field of ["pending_row", "pending_transcript", "pending_decode"] as const)
      if (typeof row[field] !== "number" || !Number.isSafeInteger(row[field]) || row[field] < 0) return null;
    if (row.oldest_started_at !== null
      && (typeof row.oldest_started_at !== "string" || !Number.isFinite(Date.parse(row.oldest_started_at)))) return null;
    return row as unknown as VoiceNotePendingSnapshot;
  } catch { return null; }
}

const live = (tcw: TinyCloudWeb, ctx: AccountContext) => tcw.did === ctx.did && tcw.spaceId === ctx.spaceId
  && currentAccountGeneration() === ctx.generation && isAccountWorkAllowed(tcw);
const keyFor = (installId: string) => `${KEY}/${installId}`;

/** A checked time is a publication heartbeat, not the time the inventory was observed. */
export async function writeVoiceNotePendingSnapshot(tcw: TinyCloudWeb, notes: readonly VoiceNoteRecording[],
  ctx: AccountContext, observedAt: string, installId = voiceNoteInstallId(), checkpoint: () => void = () => undefined): Promise<boolean> {
  if (!live(tcw, ctx)) return false;
  const projection = projectVoiceNotePending(notes, ctx.did);
  const key = keyFor(installId);
  checkpoint();
  const read = await tcw.kv.get(key);
  if (!live(tcw, ctx)) return false;
  checkpoint();
  let previous: VoiceNotePendingSnapshot | null = null;
  let etag: string | undefined;
  if (read.ok) {
    previous = parseSnapshot(read.data.data);
    if (!previous || previous.install_id !== installId) return false;
    etag = read.data.headers?.etag;
    if (!etag) return false;
  } else if (read.error.code !== "KV_NOT_FOUND") return false;
  const observed = Date.parse(observedAt);
  if (!Number.isFinite(observed) || previous && Date.parse(previous.observed_at) >= observed) return false;
  const changed = !previous || JSON.stringify(projection) !== JSON.stringify(projectFields(previous));
  if (!changed && previous && observed - Date.parse(previous.checked_at) < HEARTBEAT_MS) {
    inventoryFailures.delete(accountKey(ctx));
    return false;
  }
  const snapshot: VoiceNotePendingSnapshot = { version: 1, install_id: installId, ...projection,
    observed_at: observedAt, checked_at: new Date().toISOString(), changed_at: changed ? observedAt : previous!.changed_at };
  if (!live(tcw, ctx)) return false;
  checkpoint();
  const result = await tcw.kv.put(key, JSON.stringify(snapshot), etag ? { ifMatch: etag } : { ifNoneMatch: "*" });
  if (!live(tcw, ctx)) return false;
  checkpoint();
  if (result.ok) inventoryFailures.delete(accountKey(ctx));
  return result.ok;
}

function projectFields(snapshot: VoiceNotePendingSnapshot): VoiceNotePendingProjection {
  return { pending_row: snapshot.pending_row, pending_transcript: snapshot.pending_transcript,
    pending_decode: snapshot.pending_decode, oldest_started_at: snapshot.oldest_started_at };
}

export async function readVoiceNotePendingSnapshot(tcw: TinyCloudWeb, ctx: AccountContext,
  installId = voiceNoteInstallId()): Promise<VoiceNotePendingRead> {
  const empty: VoiceNotePendingRead = { status: "unknown", snapshot: null, oldestAgeMs: null };
  if (!live(tcw, ctx)) return empty;
  const result = await tcw.kv.get(keyFor(installId));
  if (!live(tcw, ctx)) return empty;
  if (!result.ok) return { ...empty, status: result.error.code === "KV_NOT_FOUND" ? "absent" : "unknown" };
  const snapshot = parseSnapshot(result.data.data);
  if (!snapshot || snapshot.install_id !== installId) return empty;
  const now = Date.now();
  const observed = Date.parse(snapshot.observed_at);
  const stale = observed > now || now - observed > STALE_MS;
  const oldest = snapshot.oldest_started_at === null ? null : Math.max(0, now - Date.parse(snapshot.oldest_started_at));
  return { status: inventoryFailures.has(accountKey(ctx)) ? "unknown" : stale ? "stale" : "fresh",
    snapshot, oldestAgeMs: oldest };
}
