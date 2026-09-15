import type { TinyCloudWeb } from '@tinycloud/web-sdk';
import { CONNECTORS_SQL_DB_NAME, type StoreResult } from './connectorStore';
export { prepareLegacyMeetingImport, runLegacyMeetingImport } from './legacyMeetingImport';
export type { LegacyImportEntry, LegacyImportPlan, LegacyImportReceipt, LegacyImportRun } from './legacyMeetingImport';

export interface MigrationInventoryEntry {
  meetingRef: string;
  source: string;
  sourceId: string;
  revision: string | null;
  classification: 'published' | 'deleted' | 'unverified' | 'unavailable' | 'identity_collision';
  originalStatus: 'published_snapshot' | 'not_verified';
  reason: string | null;
  /** Retained legacy association for provider verification; not proof of identity. */
  documentIdCandidate: string | null;
}
export interface MigrationInventory {
  scope: 'observed';
  entries: MigrationInventoryEntry[];
  exhausted: boolean;
  nextCursor: string | null;
  observedAt: string;
}

/** Read-only cutover audit. It does not adapt old bodies or mutate legacy rows.
 * Native activation retains them; a current provider fetch can publish a unique
 * identity, while unavailable/collision states retain the original reference.
 * Collision conclusions apply to the observed pages, not an archive snapshot.
 */
export async function inventoryConnectorMeetings(
  tcw: TinyCloudWeb,
  options: { after?: string; maxPages?: number; signal?: AbortSignal } = {},
): Promise<StoreResult<MigrationInventory>> {
  const entries: MigrationInventoryEntry[] = [];
  let cursor = options.after ?? '';
  let legacy = false;
  let hasReason = true;
  let exhausted = false;
  const maxPages = Math.max(1, Math.min(1000, options.maxPages ?? 100));
  const failure = (code: string, message: string): StoreResult<MigrationInventory> => ({ ok: false, error: { code, message } });
  try {
    const db = tcw.sql.db(CONNECTORS_SQL_DB_NAME);
    for (let page = 0; page < maxPages; page++) {
      if (options.signal?.aborted) break;
      const columns = legacy ? 'id,source,source_id,metadata' : `id,source,source_id,metadata,head_revision,publication_state${hasReason ? ',publication_unavailable_reason' : ''}`;
      const result = await db.query(`SELECT ${columns} FROM connector_meeting WHERE id > ? ORDER BY id ASC LIMIT 101`, [cursor]);
      if (!result.ok) {
        const message = result.error.message ?? '';
        if (!legacy && /no such column: head_revision/i.test(message)) { legacy = true; page--; continue; }
        if (hasReason && /no such column: publication_unavailable_reason/i.test(message)) { hasReason = false; page--; continue; }
        return failure(result.error.code ?? 'MIGRATION_INVENTORY_FAILED', message);
      }
      const rows = result.data.rows as unknown as unknown[][];
      if (!Array.isArray(rows) || rows.length > 101) return failure('MIGRATION_INVALID_PAGE', 'Complete bounded catalog page required');
      for (const row of rows.slice(0, 100)) {
        if (!Array.isArray(row) || typeof row[0] !== 'string' || row[0] <= cursor || typeof row[1] !== 'string' || typeof row[2] !== 'string') {
          return failure('MIGRATION_INVALID_IDENTITY', 'Inventory cannot silently omit malformed or reordered identities');
        }
        cursor = row[0];
        const revision = typeof row[4] === 'string' && /^[a-f0-9]{64}$/.test(row[4]) ? row[4] : null;
        const state = typeof row[5] === 'string' ? row[5] : null;
        let metadata: Record<string, unknown> = {};
        try { const parsed = JSON.parse(typeof row[3] === 'string' ? row[3] : '{}'); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) metadata = parsed; } catch { /* Metadata cannot establish a verified association. */ }
        entries.push({ meetingRef: row[0], source: row[1], sourceId: row[2], revision,
          classification: state === 'deleted' ? 'deleted' : revision ? 'published' : state === 'unavailable' ? 'unavailable' : 'unverified',
          originalStatus: revision ? 'published_snapshot' : 'not_verified', reason: typeof row[6] === 'string' ? row[6] : null,
          documentIdCandidate: typeof metadata.drive_file_id === 'string' ? metadata.drive_file_id : null });
      }
      if (rows.length <= 100) { exhausted = true; break; }
    }
    const identities = new Map<string, MigrationInventoryEntry[]>();
    for (const entry of entries) {
      const key = JSON.stringify([entry.source, entry.sourceId]);
      const group = identities.get(key) ?? []; group.push(entry); identities.set(key, group);
    }
    for (const group of identities.values()) if (group.length > 1) for (const entry of group) {
      entry.classification = 'identity_collision'; entry.reason = 'identity_collision';
    }
    return { ok: true, data: { scope: 'observed', entries, exhausted, nextCursor: exhausted ? null : cursor, observedAt: new Date().toISOString() } };
  } catch (error) {
    return failure('MIGRATION_INVENTORY_FAILED', error instanceof Error ? error.message : String(error));
  }
}
