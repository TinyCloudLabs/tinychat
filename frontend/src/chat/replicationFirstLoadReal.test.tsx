// The REAL first-load path: the real ReplicationFirstLoadSignal inside a real assistant-ui remote
// thread-list runtime whose list() reads the REAL threadStore (cold load, warm-cache revalidate,
// failed load). The fixture-stub tests of the fill supply their own signal, so only this file proves
// that the signal fires in the app. Fake timers: the 20 s deadline is never advanced, so the fill can
// only have started because the signal fired.
import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { Database } from "bun:sqlite";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { AssistantRuntimeProvider, useLocalRuntime, useRemoteThreadListRuntime } from "@assistant-ui/react";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { installDom } from "@/test/dom";
import { createThread, listThreads } from "@/lib/threadStore";
import { __resetStorageStatusForTests } from "@/lib/storageStatus";
import { ReplicationFirstLoadSignal } from "@/lib/replication/ReplicationFirstLoadSignal";
import { startReplicationFill } from "@/lib/replication/replicationClient";

class SqlService {
  readonly sqlite = new Database(":memory:");
  failReads = false;
  query = async (sql: string, params: unknown[] = []) => {
    if (this.failReads) return { ok: false as const, error: { code: "SQL", message: "unavailable" } };
    try { return { ok: true as const, data: { rows: this.sqlite.query(sql).values(...params) } }; }
    catch (error) { return { ok: false as const, error: { code: "SQL", message: String(error) } }; }
  };
  execute = async (sql: string, params: unknown[] = []) => {
    try { this.sqlite.query(sql).run(...params); return { ok: true as const, data: { rows: [] } }; }
    catch (error) { return { ok: false as const, error: { code: "SQL", message: String(error) } }; }
  };
  batch = async (operations: Array<{ sql: string; params?: unknown[] }>) => {
    try {
      this.sqlite.run("BEGIN");
      for (const operation of operations) this.sqlite.query(operation.sql).run(...(operation.params ?? []));
      this.sqlite.run("COMMIT");
      return { ok: true as const, data: { rows: [] } };
    } catch (error) { return { ok: false as const, error: { code: "SQL", message: String(error) } }; }
  };
}

function appTcw(service: SqlService): TinyCloudWeb {
  return { did: `did:test:${crypto.randomUUID()}`, sql: { db: () => service } } as unknown as TinyCloudWeb;
}

/** The sidebar's thread-list adapter shape (runtime.tsx list()), reading the real thread store. */
function Workspace({ tcw }: { tcw: TinyCloudWeb }) {
  const runtime = useRemoteThreadListRuntime({
    runtimeHook: () => useLocalRuntime({ run: async function* () { /* never sends */ } }),
    adapter: {
      async list() {
        const summaries = await listThreads(tcw);
        return { threads: summaries.map((t) => ({ status: "regular" as const, remoteId: t.id, title: t.title })) };
      },
      async initialize(threadId: string) { return { remoteId: threadId, externalId: undefined }; },
      async rename() {}, async archive() {}, async unarchive() {}, async delete() {},
      async generateTitle() { return new ReadableStream() as never; },
      async fetch(threadId: string) { return { status: "regular" as const, remoteId: threadId, title: "t" }; },
    },
  });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ReplicationFirstLoadSignal />
    </AssistantRuntimeProvider>
  );
}

function localStorageWindow(): void {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
  Object.defineProperty(window, "localStorage", { value: storage, configurable: true, writable: true });
}

let restoreDom: () => void;
beforeEach(() => {
  restoreDom = installDom();
  localStorageWindow();
  jest.useFakeTimers();
});
afterEach(async () => {
  jest.useRealTimers();
  await __resetStorageStatusForTests();
  restoreDom();
});

/** Mounts the workspace, starts the REAL fill with the DEFAULT (real) signal, never advances time. */
async function mountAndFill(tcw: TinyCloudWeb): Promise<{ syncCalls: () => number; unmount: () => Promise<void> }> {
  let calls = 0;
  const replicated = { did: tcw.did, replication: { sync: async () => { calls += 1; } } } as unknown as TinyCloudWeb;
  startReplicationFill(replicated, () => true); // arms the real signal; no firstLoadSettled override
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => { root.render(<Workspace tcw={tcw} />); });
  for (let turn = 0; turn < 200 && calls === 0; turn += 1) {
    await act(async () => { await Promise.resolve(); jest.advanceTimersByTime(0); });
  }
  return { syncCalls: () => calls, unmount: () => act(async () => root.unmount()) };
}

describe("the real app path fires the first-load signal, not the 20 s deadline", () => {
  test("cold load (no cache): the list is seen loading, then done", async () => {
    const mounted = await mountAndFill(appTcw(new SqlService()));
    expect(mounted.syncCalls()).toBe(1);
    await mounted.unmount();
  });

  test("warm cache: the cached list returns at once and the background revalidate runs then ends", async () => {
    const service = new SqlService();
    const tcw = appTcw(service);
    await createThread(tcw, "warm-1");
    await listThreads(tcw); // fills the local list cache
    const mounted = await mountAndFill(tcw);
    expect(mounted.syncCalls()).toBe(1);
    await mounted.unmount();
  });

  test("a load that fails still settles", async () => {
    const service = new SqlService();
    service.failReads = true;
    const mounted = await mountAndFill(appTcw(service));
    expect(mounted.syncCalls()).toBe(1);
    await mounted.unmount();
  });
});
