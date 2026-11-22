// The meeting tools' read port over TrustBot's delegated access: SELECTs on the connectors database and KV reads
// under connectors/, nothing else. Errors carry the codes the meeting reader classifies (mcp-meetings/reader.ts).
// Details: TC-3792
import { APP_ID, CONNECTORS_SQL_DB_NAME } from "@tinyboilerplate/core";
import { isKvMissingKeyResult } from "@tinyboilerplate/server";
import { McpPortError, type McpMeetingPort } from "../mcp-meetings/port.js";
import { ReadGrantRefused, type ReadAccess } from "./grants.js";

const KV_PREFIX = `${APP_ID}/connectors/`;

function refusalError(error: unknown): McpPortError {
  if (error instanceof McpPortError) return error;
  if (error instanceof ReadGrantRefused) {
    if (error.code === "ended") return new McpPortError("GRANT_EXPIRED");
    if (error.code === "rejected") return new McpPortError("GRANT_REJECTED");
    if (error.code === "unavailable") return new McpPortError("MCP_UNAVAILABLE");
    return new McpPortError("GRANT_REQUIRED");
  }
  return new McpPortError("STORAGE_ERROR");
}

function resultError(error: { code?: string; meta?: { status?: unknown } } | undefined): McpPortError {
  const status = error?.meta?.status;
  if (status === 401 || status === 403) return new McpPortError("GRANT_REJECTED", status);
  return new McpPortError(error?.code && /^[A-Z0-9_]{1,80}$/.test(error.code) ? error.code : "STORAGE_ERROR");
}

/** `access` is asked once per port, on its first read; a port lives for one tool call. */
export function delegatedMeetingPort(access: () => Promise<ReadAccess>): McpMeetingPort {
  let pending: Promise<ReadAccess> | undefined;
  const active = async () => {
    pending ??= access();
    try { return await pending; } catch (error) { throw refusalError(error); }
  };
  return {
    async sqlQuery(sql, params, options) {
      if (!/^\s*SELECT\b/i.test(sql) || sql.includes(";")) throw new McpPortError("SQL_NOT_READ_ONLY");
      if (options?.signal?.aborted) throw new McpPortError("ABORTED");
      const db = (await active()).sql.db(CONNECTORS_SQL_DB_NAME);
      const result = await db.query(sql, params);
      if (!result.ok) throw resultError(result.error);
      return result.data.rows;
    },
    async kvGetText(key, options) {
      if (!key.startsWith(KV_PREFIX)) throw new McpPortError("KV_OUTSIDE_PREFIX");
      if (options?.signal?.aborted) throw new McpPortError("ABORTED");
      const result = await (await active()).kv.get<unknown>(key);
      if (isKvMissingKeyResult(result, key)) throw new McpPortError("KV_NOT_FOUND");
      if (!result.ok) throw resultError(result.error);
      const value = result.data.data;
      return typeof value === "string" ? value : JSON.stringify(value);
    },
  };
}
