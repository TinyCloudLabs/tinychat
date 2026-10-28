// A writable copy of the Library fixture space for the rename screens (TC-2195): the rename's read and
// write, and the list of user-titled rows, are answered from the rows, which the list read then shows.
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { LIBRARY_ROWS, libraryTcw } from "./library";

type Row = (typeof LIBRARY_ROWS)[number];

export function renameSpaceTcw(): TinyCloudWeb {
  const rows: Row[] = LIBRARY_ROWS.map((row) => ({ ...row, metadata: { ...row.metadata } }));
  const updatedAt = new Map<string, string>(rows.map((row) => [row.id, "2026-10-06T09:00:00.000Z"]));
  const base = libraryTcw({ rows });
  const baseDb = base.sql.db("harness") as unknown as { query: (sql: string, params?: unknown[]) => Promise<unknown> };
  const query = async (sql: string, params: unknown[] = []) => {
    if (sql.startsWith("SELECT title, metadata, updated_at, source, started_at, participants FROM connector_meeting")) {
      const row = rows.find((r) => r.id === params[0]);
      return { ok: true, data: { rows: row ? [[row.title, JSON.stringify(row.metadata), updatedAt.get(row.id), row.source, row.startedAt, "[]"]] : [] } };
    }
    if (sql.startsWith("SELECT id FROM connector_meeting WHERE json_valid(metadata)")) {
      return { ok: true, data: { rows: rows.filter((r) => r.metadata.title_user === true).map((r) => [r.id]) } };
    }
    return baseDb.query(sql, params);
  };
  const execute = async (sql: string, params: unknown[] = []) => {
    if (!sql.startsWith("UPDATE connector_meeting SET title = ?, metadata = ?, updated_at = ? WHERE id = ? AND updated_at = ?")) {
      throw new Error(`renameSpace: unexpected write: ${sql}`);
    }
    const [title, metadata, now, id, was] = params as string[];
    const row = rows.find((r) => r.id === id);
    if (!row || updatedAt.get(id!) !== was) return { ok: true, data: { changes: 0 } };
    row.title = title!;
    row.metadata = JSON.parse(metadata!) as Record<string, unknown>;
    updatedAt.set(id!, now!);
    return { ok: true, data: { changes: 1 } };
  };
  return new Proxy(base, {
    get: (target, key) => (key === "sql" ? { db: () => ({ query, execute }) } : Reflect.get(target, key)),
  }) as TinyCloudWeb;
}
