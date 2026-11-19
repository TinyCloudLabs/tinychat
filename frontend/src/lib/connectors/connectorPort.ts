import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { CONNECTORS_SQL_DB_NAME } from "@tinyboilerplate/core";
import type { ConnectorStorePort, PortResult } from "@tinyboilerplate/core";
import { storageScopeFor, trackStorageWrites } from "../storageStatus";

type SqlParam = string | number | Uint8Array | null;

function failure(error: { code?: string; message?: string }): PortResult<never> {
  return { ok: false, code: error.code ?? "STORE_ERROR", message: error.message ?? "Storage unavailable" };
}

/** Browser adapter for the shared, create-only transcript writer. */
export function webConnectorPort(tcw: TinyCloudWeb): ConnectorStorePort {
  const db = trackStorageWrites(tcw.sql.db(CONNECTORS_SQL_DB_NAME), storageScopeFor(tcw));
  return {
    async query(sql, params) {
      const result = await db.query(sql, params as SqlParam[]);
      return result.ok ? { ok: true, data: { rows: result.data.rows as unknown[][] } } : failure(result.error);
    },
    async execute(sql, params) {
      const result = await db.execute(sql, params as SqlParam[] | undefined);
      return result.ok ? { ok: true, data: result.data } : failure(result.error);
    },
    async kvGet(key) {
      const result = await tcw.kv.get(key, { source: "network" });
      if (result.ok) return { ok: true, data: "present" };
      if (result.error.code === "KV_NOT_FOUND") return { ok: true, data: "missing" };
      return failure(result.error);
    },
    async kvPutIfAbsent(key, body) {
      const result = await tcw.kv.put(key, body, { ifNoneMatch: "*" });
      if (result.ok) return { ok: true, data: "written" };
      if (result.error.code === "KV_PRECONDITION_FAILED") return { ok: true, data: "exists" };
      return failure(result.error);
    },
  };
}
