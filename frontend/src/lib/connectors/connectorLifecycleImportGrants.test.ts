import { describe, expect, test } from "bun:test";
import {
  IMPORT_GRANT_REVOKE_UNCONFIRMED_MESSAGE,
  initialDisconnectProgress,
  runDisconnect,
  type DisconnectDeps,
  type DisconnectImportGrants,
  type DisconnectProgress,
} from "./connectorLifecycle";
import type { ConnectorWebhooksResult } from "./webhooksApi";

const CIDS = ["bafy-secrets", "bafy-meetings"];

function setup(options: {
  mode: DisconnectProgress["mode"];
  list?: () => ConnectorWebhooksResult<string[]>;
  revoke?: (cid: string, attempt: number) => boolean;
  disable?: () => ConnectorWebhooksResult<{ status: "disabled"; queueDropped: number }>;
}) {
  const ops: string[] = [];
  const attempts = new Map<string, number>();
  const importGrants: DisconnectImportGrants = {
    listGrantCids: async () => {
      ops.push("list-grants");
      return options.list ? options.list() : { status: "ok", value: [...CIDS] };
    },
    revoke: async (cid) => {
      const attempt = (attempts.get(cid) ?? 0) + 1;
      attempts.set(cid, attempt);
      ops.push(`revoke:${cid}`);
      return options.revoke ? options.revoke(cid, attempt) : true;
    },
  };
  const deps: DisconnectDeps = {
    connectorId: "fireflies",
    source: "fireflies",
    mode: options.mode,
    importGrants,
    webhooks: {
      disable: async () => {
        ops.push("disable-webhooks");
        return options.disable ? options.disable() : { status: "ok", value: { status: "disabled", queueDropped: 0 } };
      },
      recordPurge: async () => {
        ops.push("record-purge");
        return { status: "ok", value: null };
      },
    },
    secrets: {
      isUnlocked: () => true,
      unlock: async () => ({ ok: true }),
      deleteKey: async () => {
        ops.push("delete-key");
        return { ok: true };
      },
    },
    store: {
      listKnownSourceIds: async () => ({ ok: true, data: ["m1"] }),
      purgeConnector: async () => {
        ops.push("purge-local");
        return { ok: true, data: undefined };
      },
      clearFirefliesAttempt: async () => ({ ok: true, data: undefined }),
      getConnection: async () => ({ ok: true, data: null }),
      countMeetings: async () => ({ ok: true, data: 0 }),
      updateSyncState: async () => ({ ok: true, data: undefined }),
    },
  };
  let latest = initialDisconnectProgress(options.mode);
  const emit = (update: (prev: DisconnectProgress) => DisconnectProgress) => {
    latest = update(latest);
  };
  return { deps, ops, emit, attempts };
}

describe("disconnect withdraws the Fireflies import permissions", () => {
  test("reads the permission ids before the server drops them and revokes both after it did", async () => {
    const t = setup({ mode: "delete-data" });

    const result = await runDisconnect(t.deps, t.emit);

    expect(result.done).toBe(true);
    expect(result.notice).toBeUndefined();
    const order = (op: string) => t.ops.indexOf(op);
    expect(order("list-grants")).toBeLessThan(order("record-purge"));
    expect(order("record-purge")).toBeLessThan(order("disable-webhooks"));
    expect(order("disable-webhooks")).toBeLessThan(order(`revoke:${CIDS[0]}`));
    expect(order(`revoke:${CIDS[0]}`)).toBeLessThan(order(`revoke:${CIDS[1]}`));
    expect(order(`revoke:${CIDS[1]}`)).toBeLessThan(order("purge-local"));
  });

  test("a retry after a failed step keeps the ids it read and revokes them once", async () => {
    let failDisable = true;
    const t = setup({
      mode: "keep-data",
      disable: () => (failDisable ? { status: "retryable", httpStatus: 503, code: null } : { status: "ok", value: { status: "disabled", queueDropped: 0 } }),
    });

    const first = await runDisconnect(t.deps, t.emit);
    expect(first.done).toBe(false);
    expect(first.grantCids).toEqual(CIDS);
    expect(t.ops.filter((op) => op.startsWith("revoke:"))).toEqual([]);

    failDisable = false;
    const second = await runDisconnect(t.deps, t.emit, first);

    expect(second.done).toBe(true);
    expect(t.ops.filter((op) => op === "list-grants")).toHaveLength(1);
    expect(t.ops.filter((op) => op.startsWith("revoke:"))).toEqual(CIDS.map((cid) => `revoke:${cid}`));
  });

  test("a permission that cannot be revoked is retried once, then disclosed without failing the disconnect", async () => {
    const t = setup({ mode: "keep-data", revoke: (cid) => cid !== CIDS[1] });

    const result = await runDisconnect(t.deps, t.emit);

    expect(result.done).toBe(true);
    expect(result.notice).toContain(IMPORT_GRANT_REVOKE_UNCONFIRMED_MESSAGE);
    expect(t.attempts.get(CIDS[0])).toBe(1);
    expect(t.attempts.get(CIDS[1])).toBe(2);
  });

  test("a failed listing stops before anything is changed", async () => {
    const t = setup({ mode: "delete-data", list: () => ({ status: "retryable", httpStatus: 503, code: null }) });

    const result = await runDisconnect(t.deps, t.emit);

    expect(result.done).toBe(false);
    expect(result.failure?.step).toBe("record-purge");
    expect(result.failure?.retryable).toBe(true);
    expect(t.ops).toEqual(["list-grants"]);
  });

  test("a server with the import off holds nothing to revoke", async () => {
    const t = setup({ mode: "keep-data", list: () => ({ status: "feature-dark" }) });

    const result = await runDisconnect(t.deps, t.emit);

    expect(result.done).toBe(true);
    expect(t.ops.some((op) => op.startsWith("revoke:"))).toBe(false);
  });
});
