// The Granola CSV import through the real Meeting sources window and the real connector store.
// The space is a SQLite database the test (test/granola-csv.e2e.test.ts) owns and reaches through
// `window.__granolaCsvSql`; transcripts go to an in-page KV map. No account, no node. Driven by that test.
import { useEffect, useMemo, useState } from "react";

import { MeetingSourcesDialog } from "@/capture/meetingSources/MeetingSourcesDialog";
import { ensureSchema } from "@/lib/connectors/connectorStore";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import type { HarnessScreen } from "../screen";
import { harnessSessionStore, harnessTcw } from "../stubs";

type SqlBridge = (kind: "query" | "execute", sql: string, params: unknown[]) => Promise<unknown>;

const ok = <T,>(data: T) => ({ ok: true as const, data });

function spaceTcw(): TinyCloudWeb {
  const bridge = Reflect.get(window, "__granolaCsvSql") as SqlBridge;
  const kv = new Map<string, unknown>();
  const db = {
    query: async (sql: string, params: unknown[] = []) => ok({ rows: await bridge("query", sql, params) }),
    execute: async (sql: string, params: unknown[] = []) => ok(await bridge("execute", sql, params)),
  };
  return new Proxy(harnessTcw as object, {
    get(target, key) {
      if (key === "sql") return { db: () => db };
      if (key === "kv") {
        return {
          get: async (path: string) => ok({ data: kv.get(path), headers: {} }),
          put: async (path: string, value: unknown) => { kv.set(path, value); return ok({ data: undefined, headers: {} }); },
        };
      }
      return Reflect.get(target, key);
    },
  }) as unknown as TinyCloudWeb;
}

function GranolaCsvFixture() {
  const tcw = useMemo(spaceTcw, []);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    void ensureSchema(tcw).then(() => setReady(true));
  }, [tcw]);
  return (
    <div data-granola-csv-harness={ready ? "ready" : "pending"}>
      {ready && <MeetingSourcesDialog open onOpenChange={() => {}} tcw={tcw} backendUrl={window.location.origin} sessionStore={harnessSessionStore} />}
    </div>
  );
}

export const granolaCsvScreens: HarnessScreen[] = [
  {
    id: "granola-csv-interactive",
    group: "granolaCsv",
    layout: "pane",
    path: "/chat/connectors",
    platform: "web",
    interactive: true,
    render: () => <GranolaCsvFixture />,
  },
];
