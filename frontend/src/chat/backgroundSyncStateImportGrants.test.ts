import { describe, expect, test } from "bun:test";
import { IMPORT_GRANT_REVOKE_UNCONFIRMED_MESSAGE } from "@/lib/connectors/connectorLifecycle";
import type { ConnectorWebhooksResult } from "@/lib/connectors/webhooksApi";
import {
  disableBackgroundSync,
  initialBackgroundSyncState,
  type BackgroundSyncDeps,
  type BackgroundSyncState,
} from "./backgroundSyncState";

const CIDS = ["bafy-secrets", "bafy-meetings"];

function run(options: {
  list?: ConnectorWebhooksResult<string[]>;
  disable?: ConnectorWebhooksResult<{ status: "disabled"; queueDropped: number }>;
  revoke?: (cid: string) => boolean;
}) {
  const ops: string[] = [];
  const unsupported = async (): Promise<never> => {
    throw new Error("not used by turning Instant updates off");
  };
  const deps: BackgroundSyncDeps = {
    source: "fireflies",
    webhooks: {
      getConfig: unsupported,
      enable: unsupported,
      getPending: unsupported,
      drain: unsupported,
      clearPurgeLedger: unsupported,
      disable: async () => {
        ops.push("disable");
        return options.disable ?? { status: "ok", value: { status: "disabled", queueDropped: 0 } };
      },
    },
    secrets: { isUnlocked: () => true, unlock: unsupported },
    ingest: unsupported,
    importGrants: {
      listGrantCids: async () => {
        ops.push("list");
        return options.list ?? { status: "ok", value: [...CIDS] };
      },
      revoke: async (cid) => {
        ops.push(`revoke:${cid}`);
        return options.revoke ? options.revoke(cid) : true;
      },
    },
  };
  let state: BackgroundSyncState = initialBackgroundSyncState();
  const emit = (update: (prev: BackgroundSyncState) => BackgroundSyncState) => {
    state = update(state);
  };
  return { deps, emit, ops, state: () => state };
}

describe("turning Instant updates off withdraws the Fireflies import permissions", () => {
  test("lists them before the server drops them and revokes both afterwards", async () => {
    const t = run({});

    await disableBackgroundSync(t.deps, t.emit);

    expect(t.ops).toEqual(["list", "disable", `revoke:${CIDS[0]}`, `revoke:${CIDS[1]}`]);
    expect(t.state().phase).toBe("off");
    expect(t.state().notice?.tone).toBe("info");
  });

  test("a revoke that cannot be confirmed is disclosed", async () => {
    const t = run({ revoke: () => false });

    await disableBackgroundSync(t.deps, t.emit);

    expect(t.state().phase).toBe("off");
    expect(t.state().notice?.tone).toBe("error");
    expect(t.state().notice?.message).toContain(IMPORT_GRANT_REVOKE_UNCONFIRMED_MESSAGE);
  });

  test("a failed listing changes nothing and asks for a retry", async () => {
    const t = run({ list: { status: "retryable", httpStatus: 503, code: null } });

    await disableBackgroundSync(t.deps, t.emit);

    expect(t.ops).toEqual(["list"]);
    expect(t.state().notice?.retryable).toBe(true);
  });
});
