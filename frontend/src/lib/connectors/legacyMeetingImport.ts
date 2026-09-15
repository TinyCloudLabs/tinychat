import type { TinyCloudWeb } from '@tinycloud/web-sdk';
import { CONNECTORS_SQL_DB_NAME, publicationSha256, snapshotKvKey, transcriptKvKey, type StoreResult } from './connectorStore';

/** Contains private original data. Persist the complete plan privately BEFORE running it. */
export interface LegacyImportEntry {
  meetingRef: string;
  source: string;
  sourceId: string;
  originalCatalog: Record<string, unknown>;
  aliases: string[];
  kind: 'legacy' | 'published' | 'deleted';
  operationId: string;
  originalKey: string;
  originalDigest: string | null;
  snapshotRaw: string | null;
  revision: string | null;
}
export interface LegacyImportPlan {
  version: 1;
  scope: 'observed';
  observedAt: string;
  exhausted: boolean;
  ready: boolean;
  maxPages: number;
  maxBodyBytes: number;
  entries: LegacyImportEntry[];
  issues: { meetingRef: string | null; code: string }[];
  digest: string;
}
export interface LegacyImportReceipt {
  meetingRef: string;
  source: string;
  sourceId: string;
  operationId: string;
  originalDigest: string | null;
  revision: string | null;
  status: 'published' | 'already_published' | 'skipped_published' | 'skipped_deleted' | 'failed';
  code?: string;
}
export interface LegacyImportRun { receipts: LegacyImportReceipt[]; complete: true }
type Options = { maxPages?: number; /** Aggregate original-body budget; each body remains limited to 1 MiB. */ maxBodyBytes?: number; signal?: AbortSignal };
type Catalog = { rows: Record<string, unknown>[]; aliases: Map<string, string[]>; exhausted: boolean };
const STATEMENT = 'tinycloud.meetingPublication.v3';
const bytes = (raw: string) => new TextEncoder().encode(raw).byteLength;
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const revision = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const safeRef = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 128 && /^[A-Za-z0-9._:-]+$/.test(v) && !v.includes('..');
const safeSourceId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 512 && !/[\\/]/.test(v) && !v.includes('..');
function validHead(row: Record<string, unknown>): boolean {
  const head = row.head_revision, state = row.publication_state;
  if (head !== null && head !== undefined && !revision(head)) return false;
  if (state !== null && state !== undefined && !['published','reserved','deleted','unavailable','unverified'].includes(String(state))) return false;
  return revision(head) ? ['published','reserved'].includes(String(state)) : state !== 'published';
}
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (record(v)) return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}
class ImportFailure extends Error { constructor(readonly code: string) { super(code); } }
const check = (signal?: AbortSignal) => { if (signal?.aborted) throw new ImportFailure('MIGRATION_CANCELLED'); };
const fail = <T>(error: unknown): StoreResult<T> => ({ ok: false, error: { code: error instanceof ImportFailure ? error.code : 'MIGRATION_FAILED', message: error instanceof ImportFailure ? error.code : 'Migration failed; no original content is included in diagnostics' } });
function legacyCells(row: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(row).filter(([k]) => !k.startsWith('publication_') && !['head_revision', 'head_snapshot_key'].includes(k)));
}
async function query(tcw: TinyCloudWeb, sql: string, params: (string | number)[] = []) {
  const result = await tcw.sql.db(CONNECTORS_SQL_DB_NAME).query(sql, params);
  if (!result.ok) throw new ImportFailure('MIGRATION_CATALOG_READ_FAILED');
  const data = result.data as unknown as {columns:string[];rows:unknown[][]};
  if (!Array.isArray(data.columns) || !Array.isArray(data.rows)) throw new ImportFailure('MIGRATION_INVALID_PAGE');
  return data;
}
async function catalog(tcw: TinyCloudWeb, maxPages: number, signal?: AbortSignal): Promise<Catalog> {
  const before = await query(tcw, 'SELECT COUNT(*) AS n FROM connector_meeting');
  const count = before.rows[0]?.[0];
  if (!Number.isSafeInteger(count) || Number(count) < 0) throw new ImportFailure('MIGRATION_INVALID_COUNT');
  const rows: Record<string, unknown>[] = [];
  let cursor = '';
  let exhausted = false;
  for (let page = 0; page < maxPages; page++) {
    check(signal);
    const data = await query(tcw, 'SELECT * FROM connector_meeting WHERE id > ? ORDER BY id ASC LIMIT 101', [cursor]);
    if (data.rows.length > 101) throw new ImportFailure('MIGRATION_INVALID_PAGE');
    for (const cells of data.rows.slice(0, 100)) {
      const row = Object.fromEntries(data.columns.map((column, i) => [column, cells[i]]));
      if (typeof row.id !== 'string' || row.id <= cursor) throw new ImportFailure('MIGRATION_INVALID_IDENTITY');
      cursor = row.id; rows.push(row);
    }
    if (data.rows.length <= 100) { exhausted = true; break; }
  }
  const after = await query(tcw, 'SELECT COUNT(*) AS n FROM connector_meeting');
  exhausted = exhausted && rows.length === count && after.rows[0]?.[0] === count;
  const aliases = new Map<string, string[]>();
  cursor = '';
  for (let page = 0; page < maxPages; page++) {
    check(signal);
    const result = await tcw.sql.db(CONNECTORS_SQL_DB_NAME).query('SELECT alias,meeting_id FROM connector_meeting_alias WHERE alias > ? ORDER BY alias ASC LIMIT 101', [cursor]);
    if (!result.ok) {
      const error = result.error as {code?:string;message?:string;meta?:{status?:unknown;responseSnippet?:unknown}};
      const missing = error.code === 'SQL_ERROR' && error.meta?.status === 400
        && error.meta.responseSnippet === 'SQLite error: no such table: connector_meeting_alias';
      if (page === 0 && missing) break;
      throw new ImportFailure('MIGRATION_ALIAS_READ_FAILED');
    }
    const aliasRows = result.data.rows as unknown as unknown[][];
    if (!Array.isArray(aliasRows) || aliasRows.length > 101) throw new ImportFailure('MIGRATION_INVALID_ALIASES');
    for (const cells of aliasRows.slice(0, 100)) {
      const [alias, id] = cells;
      if (typeof alias !== 'string' || alias <= cursor || typeof id !== 'string') throw new ImportFailure('MIGRATION_INVALID_ALIASES');
      cursor = alias; aliases.set(id, [...(aliases.get(id) ?? []), alias]);
    }
    if (aliasRows.length <= 100) break;
    if (page === maxPages - 1) exhausted = false;
  }
  return { rows, aliases, exhausted };
}
async function original(tcw: TinyCloudWeb, key: string): Promise<string> {
  const result = await tcw.kv.get(key, { raw: true });
  if (!result.ok) {
    const error = result.error as {code?:string;message?:string;status?:unknown;meta?:{status?:unknown}};
    const status = error.status ?? error.meta?.status;
    const message = error.message ?? '';
    if (error.code === 'KV_NOT_FOUND' && status !== 401 && status !== 403
      && /\b(?:key|entry) not found\b/i.test(message)
      && !/space.{0,30}(?:not found|not hosted|unavailable)/i.test(message)) throw new ImportFailure('MIGRATION_BODY_MISSING');
    throw new ImportFailure('MIGRATION_BODY_READ_FAILED');
  }
  if (typeof result.data.data !== 'string') throw new ImportFailure('MIGRATION_BODY_INVALID');
  return result.data.data;
}
function parseCell(row: Record<string, unknown>, key: string, empty: unknown): unknown {
  const value = row[key];
  if (value === null) return empty;
  if (typeof value !== 'string') throw new ImportFailure('MIGRATION_METADATA_INVALID');
  try { return JSON.parse(value); } catch { throw new ImportFailure('MIGRATION_METADATA_INVALID'); }
}

/** Complete bounded SQL/legacy-KV inventory. No schema creation, activation or upstream fetch. */
export async function prepareLegacyMeetingImport(tcw: TinyCloudWeb, options: Options = {}): Promise<StoreResult<LegacyImportPlan>> {
  try {
    const maxPages = Math.max(1, Math.min(1000, options.maxPages ?? 100));
    const maxBodyBytes = options.maxBodyBytes ?? 128 * 1024 * 1024;
    if (!Number.isSafeInteger(maxPages) || !Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1) throw new ImportFailure('MIGRATION_INVALID_BOUNDS');
    const data = await catalog(tcw, maxPages, options.signal);
    const plan: LegacyImportPlan = { version: 1, scope: 'observed', observedAt: new Date().toISOString(), exhausted: data.exhausted, ready: false, maxPages, maxBodyBytes, entries: [], issues: [], digest: '' };
    const issue = (meetingRef: string | null, code: string) => plan.issues.push({ meetingRef, code });
    if (!data.exhausted) issue(null, 'MIGRATION_INVENTORY_INCOMPLETE');
    const identities = new Set<string>();
    const ids = new Set(data.rows.map(row => row.id));
    const seenAliases = new Set<string>();
    let totalBytes = 0;
    for (const row of data.rows) {
      check(options.signal);
      const id = typeof row.id === 'string' ? row.id : '';
      const source = typeof row.source === 'string' ? row.source : '';
      const sourceId = typeof row.source_id === 'string' ? row.source_id : '';
      const entry: LegacyImportEntry = { meetingRef: id, source, sourceId, originalCatalog: row, aliases: data.aliases.get(id) ?? [], kind: row.publication_state === 'deleted' ? 'deleted' : revision(row.head_revision) ? 'published' : 'legacy', operationId: crypto.randomUUID(), originalKey: transcriptKvKey(source, sourceId), originalDigest: null, snapshotRaw: null, revision: null };
      plan.entries.push(entry);
      const identity = JSON.stringify([source, sourceId]);
      if (identities.has(identity)) issue(id, 'MIGRATION_IDENTITY_COLLISION');
      identities.add(identity);
      if (!safeRef(id) || !['fireflies', 'google-meet', 'tinycloud-transcriber'].includes(source) || !safeSourceId(sourceId)) { issue(id, 'MIGRATION_INVALID_IDENTITY'); continue; }
      if (!validHead(row)) { issue(id,'MIGRATION_PUBLICATION_STATE_INVALID'); continue; }
      for (const alias of entry.aliases) {
        if (!safeRef(alias) || (ids.has(alias) && alias !== id) || seenAliases.has(alias)) issue(id, 'MIGRATION_ALIAS_COLLISION');
        seenAliases.add(alias);
      }
      if (entry.kind !== 'legacy') continue;
      try {
        const raw = await original(tcw, entry.originalKey);
        const size = bytes(raw); totalBytes += size;
        if (size > 1_048_576 || totalBytes > maxBodyBytes) throw new ImportFailure('MIGRATION_BODY_CAPACITY');
        if (new TextDecoder().decode(new TextEncoder().encode(raw)) !== raw) throw new ImportFailure('MIGRATION_BODY_INVALID_UTF8');
        let records: unknown;
        try { records = JSON.parse(raw); } catch { throw new ImportFailure('MIGRATION_BODY_INVALID_JSON'); }
        if (!Array.isArray(records) || records.some(item => !record(item) || typeof item.text !== 'string')) throw new ImportFailure('MIGRATION_BODY_INVALID_RECORDS');
        const metadata = parseCell(row, 'metadata', {});
        const participants = parseCell(row, 'participants', []);
        const keywords = parseCell(row, 'keywords', null);
        if (!record(metadata) || !Array.isArray(participants) || participants.some(item => !record(item))) throw new ImportFailure('MIGRATION_METADATA_INVALID');
        if (row.duration_secs !== null && (typeof row.duration_secs !== 'number' || !Number.isFinite(row.duration_secs))) throw new ImportFailure('MIGRATION_DURATION_UNSUPPORTED');
        for (const field of ['title','started_at','organizer_email','summary_overview','summary_action_items','meeting_type','created_at','updated_at']) {
          if (row[field] !== null && typeof row[field] !== 'string') throw new ImportFailure('MIGRATION_METADATA_INVALID');
        }
        entry.originalDigest = await publicationSha256(raw);
        const snapshot = {
          contractVersion: 3, meetingRef: id, source, sourceId, operationId: entry.operationId, createdAt: plan.observedAt,
          metadata: { title: row.title, startedAt: row.started_at, organizerEmail: row.organizer_email,
            participants: participants.map(item => ({ ...item, ...(typeof item.name === 'string' ? {name:item.name} : {}), ...(typeof item.email === 'string' ? {email:item.email} : {}) })).map(item => Object.fromEntries(Object.entries(item).filter(([k,v]) => !['name','email'].includes(k) || typeof v === 'string'))),
            metadata: { ...metadata, connector_fields: { durationSecs: row.duration_secs, summaryActionItems: row.summary_action_items, keywords, meetingType: row.meeting_type } } },
          body: { basis: metadata.notes_kind || metadata.basis === 'notes' || metadata.artifactType === 'notes' ? 'notes' : 'transcript', encoding: 'utf-8', schema: 'json-records', raw,
            original: { digest: entry.originalDigest, byteLength: size, recordCount: records.length, extent: 'unknown', captureComplete: null }, omissions: [{code:'legacy_capture_unverified'}] },
          overview: row.summary_overview === null ? null : { text: row.summary_overview, provenance: { provider: null, generatedAt: null, sourceDigest: null, freshness: 'unknown' } },
          aliases: entry.aliases,
          legacyImport: { version: 1, upstreamVerified: false, observedAt: plan.observedAt, originalKey: entry.originalKey, originalCatalog: row },
        };
        entry.snapshotRaw = JSON.stringify(snapshot);
        entry.revision = await publicationSha256(entry.snapshotRaw);
        const transport = { action:'execute', sql:STATEMENT, params:[JSON.stringify({contractVersion:3,operation:'stage',source,sourceId,operationId:entry.operationId,generation:Number.MAX_SAFE_INTEGER,expectedHead:null,meetingRef:id,revision:entry.revision,snapshotKey:snapshotKvKey(source,sourceId,entry.revision),snapshotRaw:entry.snapshotRaw})] };
        if (bytes(JSON.stringify(transport)) > 2_097_152) throw new ImportFailure('MIGRATION_ENVELOPE_CAPACITY');
      } catch (error) { if (!(error instanceof ImportFailure)) throw error; issue(id, error.code); }
    }
    for (const id of data.aliases.keys()) if (!ids.has(id)) issue(id, 'MIGRATION_ALIAS_ORPHAN');
    plan.ready = plan.exhausted && plan.issues.length === 0;
    plan.digest = await publicationSha256(canonical({ ...plan, digest: '' }));
    return {ok:true,data:plan};
  } catch (error) { return fail(error); }
}

async function command(tcw: TinyCloudWeb, input: Record<string, unknown>) {
  const result = await tcw.sql.db(CONNECTORS_SQL_DB_NAME).execute(STATEMENT, [JSON.stringify({contractVersion:3,...input})]);
  if (!result.ok) throw new ImportFailure(`MIGRATION_${String(input.operation).toUpperCase()}_FAILED`);
  const data = result.data as unknown as {columns?:string[];rows?:unknown[][]};
  if (data.columns?.[0] !== 'receipt' || data.rows?.length !== 1 || typeof data.rows[0]?.[0] !== 'string') throw new ImportFailure('MIGRATION_INVALID_RECEIPT');
  let receipt: unknown;
  try { receipt = JSON.parse(data.rows[0][0]); } catch { throw new ImportFailure('MIGRATION_INVALID_RECEIPT'); }
  if (!record(receipt) || receipt.contractVersion !== 3) throw new ImportFailure('MIGRATION_INVALID_RECEIPT');
  return receipt;
}

/** Resume only with the original saved plan. Never overwrites a previously published head.
 * Full inventory is observed, not a cross-client transaction: coordinate other connector writers
 * throughout migration. Native operation/generation/head checks protect each publication.
 */
export async function runLegacyMeetingImport(tcw: TinyCloudWeb, plan: LegacyImportPlan, options: { signal?: AbortSignal; onReceipt?: (receipt: LegacyImportReceipt) => void | Promise<void> } = {}): Promise<StoreResult<LegacyImportRun>> {
  const receipts: LegacyImportReceipt[] = [];
  const emit = async (entry: LegacyImportEntry, status: LegacyImportReceipt['status'], code?: string) => {
    const receipt = { meetingRef:entry.meetingRef,source:entry.source,sourceId:entry.sourceId,operationId:entry.operationId,originalDigest:entry.originalDigest,revision:entry.revision,status,...(code ? {code} : {}) };
    receipts.push(receipt); await options.onReceipt?.(receipt);
  };
  try {
    check(options.signal);
    if (plan.version !== 1 || !plan.ready || !plan.exhausted || plan.issues.length || await publicationSha256(canonical({...plan,digest:''})) !== plan.digest) throw new ImportFailure('MIGRATION_PLAN_INVALID');
    const current = await catalog(tcw, plan.maxPages, options.signal);
    if (!current.exhausted || current.rows.length !== plan.entries.length) throw new ImportFailure('MIGRATION_CATALOG_CHANGED');
    const rows = new Map(current.rows.map(row => [row.id, row]));
    for (const [id,aliases] of current.aliases) {
      if (!rows.has(id) || aliases.some(alias => !safeRef(alias) || (rows.has(alias) && alias !== id))) throw new ImportFailure('MIGRATION_ALIASES_CHANGED');
    }
    // Finish every read/check before ANY activation; never partially approve a plan.
    for (const entry of plan.entries) {
      check(options.signal);
      const row = rows.get(entry.meetingRef);
      if (!row || row.source !== entry.source || row.source_id !== entry.sourceId) throw new ImportFailure('MIGRATION_CATALOG_CHANGED');
      if (!validHead(row)) throw new ImportFailure('MIGRATION_PUBLICATION_STATE_INVALID');
      if (row.publication_state === 'deleted' || revision(row.head_revision)) continue;
      if (entry.kind !== 'legacy' || canonical(legacyCells(row)) !== canonical(legacyCells(entry.originalCatalog)) || canonical(current.aliases.get(entry.meetingRef) ?? []) !== canonical(entry.aliases)) throw new ImportFailure('MIGRATION_CATALOG_CHANGED');
      if (await publicationSha256(await original(tcw, entry.originalKey)) !== entry.originalDigest) throw new ImportFailure('MIGRATION_BODY_CHANGED');
    }
    const pending = plan.entries.some(entry => { const row = rows.get(entry.meetingRef)!; return row.publication_state !== 'deleted' && !revision(row.head_revision); });
    if (pending) {
      check(options.signal);
      const caps = await command(tcw, {operation:'capabilities'});
      if (caps.writerFencing !== true || caps.snapshotImmutability !== true || caps.digestVerification !== true) throw new ImportFailure('MIGRATION_UPGRADE_REQUIRED');
      check(options.signal);
      if ((await command(tcw, {operation:'activate'})).status !== 'ready') throw new ImportFailure('MIGRATION_ACTIVATION_FAILED');
    }
    for (const entry of plan.entries) {
      check(options.signal);
      try {
        const data = await query(tcw, 'SELECT * FROM connector_meeting WHERE id = ?', [entry.meetingRef]);
        if (data.rows.length !== 1) throw new ImportFailure('MIGRATION_CATALOG_CHANGED');
        const row = Object.fromEntries(data.columns.map((key,i) => [key,data.rows[0][i]]));
        if (row.source !== entry.source || row.source_id !== entry.sourceId) throw new ImportFailure('MIGRATION_CATALOG_CHANGED');
        if (!validHead(row)) throw new ImportFailure('MIGRATION_PUBLICATION_STATE_INVALID');
        if (row.publication_state === 'deleted') { await emit(entry,'skipped_deleted'); continue; }
        const identity = {source:entry.source,sourceId:entry.sourceId,operationId:entry.operationId};
        if (revision(row.head_revision) && row.head_revision !== entry.revision) { await emit(entry,'skipped_published'); continue; }
        const inspected = await command(tcw, {operation:'inspect',...identity});
        if (inspected.status === 'published' && inspected.operationId === entry.operationId && inspected.revision === entry.revision && inspected.meetingRef === entry.meetingRef) { await emit(entry,'already_published'); continue; }
        if (revision(row.head_revision)) { await emit(entry,'skipped_published'); continue; }
        if (canonical(legacyCells(row)) !== canonical(legacyCells(entry.originalCatalog))) throw new ImportFailure('MIGRATION_CATALOG_CHANGED');
        check(options.signal);
        const reserved = await command(tcw, {operation:'reserve',...identity});
        if (reserved.status !== 'reserved' || reserved.operationId !== entry.operationId || reserved.meetingRef !== entry.meetingRef || !Number.isSafeInteger(reserved.generation) || reserved.expectedHead !== null) throw new ImportFailure('MIGRATION_RESERVATION_CONFLICT');
        if (await publicationSha256(await original(tcw, entry.originalKey)) !== entry.originalDigest) throw new ImportFailure('MIGRATION_BODY_CHANGED');
        if (!entry.snapshotRaw || !entry.revision) throw new ImportFailure('MIGRATION_PLAN_INVALID');
        const payload = {...identity,meetingRef:entry.meetingRef,generation:reserved.generation,expectedHead:null,revision:entry.revision,snapshotKey:snapshotKvKey(entry.source,entry.sourceId,entry.revision)};
        check(options.signal);
        const staged = await command(tcw, {operation:'stage',...payload,snapshotRaw:entry.snapshotRaw});
        if (staged.status !== 'staged' || staged.revision !== entry.revision || staged.snapshotKey !== payload.snapshotKey) throw new ImportFailure('MIGRATION_STAGE_UNCONFIRMED');
        check(options.signal);
        let published: Record<string, unknown>;
        try { published = await command(tcw, {operation:'publish',...payload}); }
        catch { published = await command(tcw, {operation:'inspect',...identity}); }
        if (published.status !== 'published' || published.operationId !== entry.operationId || published.revision !== entry.revision || published.meetingRef !== entry.meetingRef) throw new ImportFailure('MIGRATION_PUBLISH_UNCONFIRMED');
        await emit(entry,'published');
      } catch (error) { await emit(entry,'failed',error instanceof ImportFailure ? error.code : 'MIGRATION_FAILED'); throw error; }
    }
    return {ok:true,data:{receipts,complete:true}};
  } catch (error) { return fail(error); }
}
