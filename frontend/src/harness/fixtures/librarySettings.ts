// The harness library space with cross-device settings in it, for the screens that need one set (a linked calendar).
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { libraryTcw } from "./library";

type Query = (sql: string, params?: unknown[]) => Promise<unknown>;

/**
 * `libraryTcw(options)` whose `settings` table holds `settings`: `getSetting` reads them, and every other statement
 * is the fixture's own.
 */
export function libraryTcwWithSettings(options: Parameters<typeof libraryTcw>[0], settings: Readonly<Record<string, string>>): TinyCloudWeb {
  const tcw = libraryTcw(options);
  // The fixture's `sql` is a plain `{ db: () => ({ query, execute }) }`, not the SDK's class: read it as what it is.
  const fixtureSql = tcw.sql as unknown as { db: (name: string) => { query: Query } };
  const db = (name: string) => {
    const stored = fixtureSql.db(name);
    const query: Query = async (sql, params = []) => {
      if (!sql.includes("SELECT value FROM settings WHERE key = ?")) return stored.query(sql, params);
      const value = settings[String(params[0])];
      return { ok: true, data: { rows: value === undefined ? [] : [[value]] } };
    };
    return { ...stored, query };
  };
  return new Proxy(tcw, { get: (target, key) => (key === "sql" ? { db } : Reflect.get(target, key)) });
}
