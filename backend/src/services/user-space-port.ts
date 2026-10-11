import { CONNECTORS_KV_PREFIX, CONNECTORS_SQL_DB_NAME, type ConnectorStorePort, type PortResult } from "@tinyboilerplate/core";
import { isKvMissingKeyResult, type DelegatedAccess } from "@tinyboilerplate/server";

export type MeteredWrite = <T>(operation: () => Promise<T>) => Promise<T>;

/** Confine the adapter to the connector database and the transcriber body prefix. */
export function delegatedConnectorPort(access: DelegatedAccess, meter: MeteredWrite): ConnectorStorePort {
  const db = access.sql.db(CONNECTORS_SQL_DB_NAME);
  const prefix = `${CONNECTORS_KV_PREFIX}/tinycloud-transcriber/`;
  const assertKey = (key: string) => {
    if (!key.startsWith(prefix)) throw new Error("Transcript key outside delegated prefix");
  };
  // Keep the SDK's HTTP status (`meta.status`): SDK 3.1 codes alone are ambiguous. A refusal is
  // SQL_PERMISSION_DENIED (403) or AUTH_UNAUTHORIZED (401, and a KV 403); a full space is
  // STORAGE_QUOTA_EXCEEDED (402); a SQL 429 is SQL_QUOTA_EXCEEDED, a rate limit, not a full space.
  const convert = <T>(result: { ok: boolean; data?: T; error?: { code?: string; message?: string; meta?: { status?: unknown } } }): PortResult<T> => {
    if (result.ok) return { ok: true, data: result.data as T };
    const status = result.error?.meta?.status;
    return {
      ok: false,
      code: /no such table\b|relation [^\n]{1,128} does not exist\b/i.test(result.error?.message ?? "")
        ? "SCHEMA_MISSING" : result.error?.code ?? "STORAGE_ERROR",
      message: result.error?.message ?? "Storage operation failed",
      ...(typeof status === "number" && Number.isInteger(status) ? { status } : {}),
    };
  };
  return {
    async query(sql, params) {
      if (!/^\s*SELECT\b/i.test(sql) || sql.includes(";")) throw new Error("Delegated connector queries must be SELECT");
      return convert(await db.query(sql, params as Parameters<typeof db.query>[1]));
    },
    async execute(sql, params) {
      if (!/^\s*INSERT INTO connector_meeting\b/i.test(sql) || sql.includes(";")) throw new Error("Delegated connector writes must be INSERT");
      return convert(await meter(() => db.execute(sql, params as Parameters<typeof db.execute>[1])));
    },
    async kvGet(key) {
      assertKey(key);
      const result = await access.kv.get(key);
      if (isKvMissingKeyResult(result, key)) return { ok: true, data: "missing" };
      if (!result.ok) return convert(result);
      return { ok: true, data: "present" };
    },
    async kvPutIfAbsent(key, body) {
      assertKey(key);
      const result = await meter(() => access.kv.put(key, body, { ifNoneMatch: "*" }));
      if (!result.ok && result.error.code === "KV_PRECONDITION_FAILED") return { ok: true, data: "exists" };
      if (!result.ok) console.warn(`[transcript-delivery] op=space_kv_put result=error code=${result.error.code}`);
      if (!result.ok) return convert(result);
      return { ok: true, data: "written" };
    },
  };
}
