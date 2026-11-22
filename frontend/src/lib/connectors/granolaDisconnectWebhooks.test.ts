// A Granola disconnect leaves the owner's Fireflies instant updates alone: `DELETE /config` is
// owner-wide (it revokes the one webhook token and clears every source's queue), and Granola has no
// push lane of its own.

import { describe, expect, test } from "bun:test";

import {
  initialDisconnectProgress,
  planFor,
  runDisconnect,
  type DisconnectDeps,
  type DisconnectMode,
  type DisconnectProgress,
} from "./connectorLifecycle";

function deps(connectorId: "granola" | "fireflies", mode: DisconnectMode, calls: string[]): DisconnectDeps {
  return {
    connectorId,
    source: connectorId,
    mode,
    webhooks: {
      disable: async () => {
        calls.push("disable");
        return { status: "ok", value: { queueDropped: 0 } } as never;
      },
      recordPurge: async () => {
        calls.push("record-purge");
        return { status: "ok", value: null } as never;
      },
    },
    secrets: {
      isUnlocked: () => true,
      unlock: async () => ({ ok: true }),
      deleteKey: async () => {
        calls.push("delete-key");
        return { ok: true };
      },
    },
    store: {
      listKnownSourceIds: async () => ({ ok: true, data: ["01JMEETINGAAA"] }),
      purgeConnector: async () => ({ ok: true, data: undefined }),
      clearFirefliesAttempt: async () => ({ ok: true, data: undefined }),
      getConnection: async () => ({ ok: true, data: null }),
      countMeetings: async () => ({ ok: true, data: 0 }),
      updateSyncState: async () => ({ ok: true, data: undefined }),
    },
  };
}

async function run(connectorId: "granola" | "fireflies", mode: DisconnectMode): Promise<{ calls: string[]; final: DisconnectProgress }> {
  const calls: string[] = [];
  let current = initialDisconnectProgress(mode);
  const final = await runDisconnect(deps(connectorId, mode, calls), (update) => {
    current = update(current);
  });
  return { calls, final };
}

describe("Granola disconnect and the webhook config", () => {
  for (const mode of ["keep-data", "delete-data"] as const) {
    test(`${mode}: the owner-wide config delete is never sent for Granola, the rest of the plan completes`, async () => {
      const { calls, final } = await run("granola", mode);
      expect(calls).not.toContain("disable");
      expect(calls).toContain("delete-key");
      expect(final.done).toBe(true);
      expect(final.completed).not.toContain("disable-webhooks");
    });

    test(`${mode}: Fireflies still turns its webhooks off`, async () => {
      const { calls, final } = await run("fireflies", mode);
      expect(calls).toContain("disable");
      expect(final.done).toBe(true);
    });
  }

  test("a Granola delete-data run still writes the purge record", async () => {
    const { calls } = await run("granola", "delete-data");
    expect(calls).toContain("record-purge");
    expect(planFor({ connectorId: "granola", mode: "delete-data", webhooks: deps("granola", "delete-data", []).webhooks })).toContain("record-purge");
  });
});
