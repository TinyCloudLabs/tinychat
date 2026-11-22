/**
 * The only data path chat has to meeting content: the hosted TinyCloud MCP's own `tinycloud_sql_query`
 * and `tinycloud_kv_get`, read-only. The endpoint, service credential, both header names and the expired/rejected
 * 401 values are configuration (the MCP's native-auth contract is defined in js-sdk packages/mcp native-auth).
 */

/** Hosted MCP replaces any read result over 100,000 serialized characters with an error (packages/mcp/src/results.ts). */
export const MCP_RESULT_CHAR_LIMIT = 100_000;
/** Page budget for SQL rows: leaves room for the envelope, column names and per-row paging columns under the cap. */
export const MCP_SQL_PAGE_BYTE_BUDGET = 48_000;

export class McpPortError extends Error {
  constructor(readonly code: string, readonly status?: number) { super(code); this.name = "McpPortError"; }
}

/** Read-only meeting data access for one owner. */
export interface McpMeetingPort {
  /** One SELECT against `xyz.tinycloud.tinychat/connectors`; resolves to row arrays. */
  sqlQuery(sql: string, params: Array<string | number | null>, options?: { signal?: AbortSignal }): Promise<unknown[][]>;
  /** One KV key under the connectors prefix, as text. */
  kvGetText(key: string, options?: { signal?: AbortSignal }): Promise<string>;
  /** Optional KV text read returning node-supplied metadata (`lastModified`), used for purge checks. */
  kvGetWithMeta?(key: string, options?: { signal?: AbortSignal }): Promise<{ value: string; lastModified?: string }>;
  /** Optional bounded KV prefix listing (`tinycloud_kv_list`), used only when Fireflies KV discovery is enabled. */
  kvList?(
    prefix: string,
    options?: { limit?: number; cursor?: string; signal?: AbortSignal },
  ): Promise<{ keys: string[]; truncated: boolean; cursor?: string }>;
}

export interface McpHttpConfig {
  /** Full MCP endpoint URL (streamable HTTP). */
  url: string;
  /** Service credential value for the MCP's separate credential header. */
  serviceCredential: string;
  /** Header names are supplied by the MCP's native-auth contract. */
  serviceCredentialHeader: string;
  ownerDidHeader: string;
  /**
   * Values of the 401 JSON `error` field that mean "grant expired" and "grant rejected". Supplied by the
   * MCP's native-auth contract; any other 401 is treated as "grant required". No values are assumed.
   */
  grantErrors?: { expired?: string; rejected?: string };
  /** Space holding the connectors db and KV prefix. */
  space: string;
  database: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

let nextId = 1;

/** Build a port for one owner. `ownerDid` must come from the authenticated session, never a request body. */
export function createHttpMcpPort(config: McpHttpConfig, ownerDid: string): McpMeetingPort {
  const doFetch = config.fetchImpl ?? fetch;
  const call = async (tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> => {
    const timeout = AbortSignal.timeout(config.timeoutMs ?? 10_000);
    const res = await doFetch(config.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        [config.serviceCredentialHeader]: config.serviceCredential,
        [config.ownerDidHeader]: ownerDid,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method: "tools/call", params: { name: tool, arguments: args } }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    }).catch((error: unknown) => {
      if ((error as { name?: string })?.name === "TimeoutError") throw new McpPortError("TIMEOUT");
      if ((error as { name?: string })?.name === "AbortError") throw new McpPortError("ABORTED");
      throw new McpPortError("MCP_UNREACHABLE");
    });
    const text = await res.text();
    const parsed = parseBody(text, res.headers.get("content-type") ?? "");
    if (res.status === 401) {
      const detail = typeof parsed?.error === "string" ? parsed.error : undefined;
      const code = detail !== undefined && detail === config.grantErrors?.expired ? "GRANT_EXPIRED"
        : detail !== undefined && detail === config.grantErrors?.rejected ? "GRANT_REJECTED" : "GRANT_REQUIRED";
      throw new McpPortError(code, 401);
    }
    if (!res.ok) throw new McpPortError("MCP_HTTP_ERROR", res.status);
    const result = (parsed?.result ?? {}) as { structuredContent?: Record<string, unknown> };
    const structured = result.structuredContent;
    if (!structured) throw new McpPortError("MCP_BAD_RESPONSE");
    if (structured.status === "authority_required") throw new McpPortError("GRANT_REQUIRED");
    if (structured.status !== "ok") {
      const error = structured.error as { code?: unknown; details?: { reason?: unknown } } | undefined;
      // After the owner revokes the grant on the node, the MCP answers 200 with AUTH_REQUIRED and one of these reasons.
      // That is the same user-visible state as no grant: connect again.
      if (error?.code === "AUTH_REQUIRED" && (error.details?.reason === "delegation_revoked" || error.details?.reason === "delegation_ancestor_revoked")) {
        throw new McpPortError("GRANT_REQUIRED");
      }
      const code = error?.code;
      throw new McpPortError(typeof code === "string" && /^[A-Z0-9_]{1,80}$/.test(code) ? code : "MCP_ERROR");
    }
    return (structured.output ?? {}) as Record<string, unknown>;
  };
  return {
    async sqlQuery(sql, params, options) {
      const output = await call("tinycloud_sql_query", {
        space: config.space, database: config.database, sql, params, maxRows: 500, maxBytes: MCP_RESULT_CHAR_LIMIT,
      }, options?.signal);
      if (!Array.isArray(output.rows)) throw new McpPortError("MCP_BAD_RESPONSE");
      return output.rows as unknown[][];
    },
    async kvGetText(key, options) {
      const output = await call("tinycloud_kv_get", { space: config.space, key, representation: "text" }, options?.signal);
      if (typeof output.value !== "string") throw new McpPortError("MCP_BAD_RESPONSE");
      return output.value;
    },
    async kvGetWithMeta(key, options) {
      const output = await call("tinycloud_kv_get", { space: config.space, key, representation: "text" }, options?.signal);
      if (typeof output.value !== "string") throw new McpPortError("MCP_BAD_RESPONSE");
      const rawLastMod = (output.metadata as { lastModified?: unknown } | undefined)?.lastModified;
      const lastModified =
        typeof rawLastMod === "string" && Number.isFinite(Date.parse(rawLastMod))
          ? new Date(Date.parse(rawLastMod)).toISOString()
          : undefined;
      return { value: output.value, ...(lastModified ? { lastModified } : {}) };
    },
    async kvList(prefix, options) {
      // Upstream `tinycloud_kv_list` (js-sdk packages/operations/src/operations/exploration.ts:212-223)
      // uses a `.strict()` schema accepting `{ space, prefix?, limit? }` (`limit` integer 1..1000).
      // Guard against NaN/non-finite limits and omit `cursor` unless explicitly provided.
      const rawLimit = options?.limit;
      const limit =
        typeof rawLimit === "number" && Number.isFinite(rawLimit)
          ? Math.max(1, Math.min(1000, Math.trunc(rawLimit)))
          : 100;
      const output = await call(
        "tinycloud_kv_list",
        {
          space: config.space,
          prefix,
          limit,
          ...(options?.cursor !== undefined ? { cursor: options.cursor } : {}),
        },
        options?.signal,
      );
      if (!Array.isArray(output.keys)) throw new McpPortError("MCP_BAD_RESPONSE");
      const keys = output.keys.filter((key): key is string => typeof key === "string");
      const nextCursor =
        typeof output.cursor === "string" && output.cursor.length > 0 ? output.cursor : undefined;
      return {
        keys,
        truncated: output.truncated === true,
        ...(nextCursor ? { cursor: nextCursor } : {}),
      };
    },
  };
}

function parseBody(text: string, contentType: string): Record<string, any> | undefined {
  try {
    if (contentType.includes("text/event-stream")) {
      const data = text.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trim()).filter(Boolean).pop();
      return data ? JSON.parse(data) : undefined;
    }
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export interface NativeGrantAccepted { ownerDid: string; serviceDid: string; expiresAt: string }

/**
 * Hand the user's serialized grant to the MCP (POST /native/grant). Backend only: the MCP refuses any request that
 * carries an Origin header, and Node's fetch sends none. No owner header is sent; the MCP derives the owner from the
 * signed grant itself.
 */
export async function postNativeGrant(config: McpHttpConfig, delegation: string): Promise<NativeGrantAccepted> {
  const doFetch = config.fetchImpl ?? fetch;
  const res = await doFetch(new URL("/native/grant", config.url), {
    method: "POST",
    headers: { "content-type": "application/json", [config.serviceCredentialHeader]: config.serviceCredential },
    body: JSON.stringify({ delegation }),
    signal: AbortSignal.timeout(config.timeoutMs ?? 10_000),
  }).catch(() => { throw new McpPortError("MCP_UNREACHABLE"); });
  const parsed = parseBody(await res.text(), res.headers.get("content-type") ?? "");
  if (res.status === 401) {
    const detail = typeof parsed?.error === "string" ? parsed.error : undefined;
    throw new McpPortError(detail !== undefined && detail === config.grantErrors?.expired ? "GRANT_EXPIRED"
      : detail !== undefined && detail === config.grantErrors?.rejected ? "GRANT_REJECTED" : "GRANT_REQUIRED", 401);
  }
  if (res.status === 403) throw new McpPortError("MCP_SERVICE_UNAUTHORIZED", 403);
  if (res.status !== 201 || typeof parsed?.ownerDid !== "string" || typeof parsed?.serviceDid !== "string" || typeof parsed?.expiresAt !== "string") {
    throw new McpPortError("MCP_UNAVAILABLE", res.status);
  }
  return { ownerDid: parsed.ownerDid, serviceDid: parsed.serviceDid, expiresAt: parsed.expiresAt };
}
