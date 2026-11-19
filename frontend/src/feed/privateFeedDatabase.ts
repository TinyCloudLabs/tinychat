import type { QueryOptions, SqlValue } from "@tinycloud/sdk-services";
import type { FeedDatabase } from "@tinycloud/sdk-services/feed";

const privateOptions = { redactErrors: true } as const;
const databases = new WeakMap<FeedDatabase, FeedDatabase>();
function sensitiveOptions<T extends { redactErrors?: boolean }>(options?: T): T | typeof privateOptions {
  return options?.redactErrors ? options : options ? { ...options, redactErrors: true } : privateOptions;
}

/** SQL sanitizes before SERVICE_ERROR emission, not after a subscriber saw private input. */
export function privateFeedDatabase(database: FeedDatabase, beforeRequest?: () => void): FeedDatabase {
  const existing = beforeRequest ? undefined : databases.get(database);
  if (existing) return existing;
  const wrapped: FeedDatabase = {
    query<T>(sql: string, params?: SqlValue[], options?: QueryOptions) { beforeRequest?.(); return database.query<T>(sql, params, sensitiveOptions(options)); },
    execute(sql, params, options) { beforeRequest?.(); return database.execute(sql, params, sensitiveOptions(options)); },
    batch(statements, options) { beforeRequest?.(); return database.batch(statements, sensitiveOptions(options)); },
  };
  if (!beforeRequest) databases.set(database, wrapped);
  databases.set(wrapped, wrapped);
  return wrapped;
}

/** Parser snippets and attached causes may contain codes or private owner notes. */
export function parseOwnerJSON(bytes: string, message: string): unknown {
  try { return JSON.parse(bytes); }
  catch { throw new Error(message); }
}
