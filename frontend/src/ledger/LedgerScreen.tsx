import { useEffect, useMemo, useState } from "react";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { AppBar } from "@/apps/AppBar";
import { accountCacheKey, readLocal } from "@/lib/localFirst/localCache";
import { appPinId } from "@/shell/navPins";
import { foldLedger, LEDGER_APP_ID, type LedgerRecord } from "./model";
import { loadLedger } from "./loadLedger";
import { LedgerView } from "./LedgerView";

type Loaded = { client: TinyCloudWeb | null; account: string | null; records: LedgerRecord[]; names: Map<string, string>; state: "loading" | "ready" | "failed" };

export function LedgerScreen({ tcw, accountDid }: { tcw: TinyCloudWeb | null; accountDid: string | null }) {
  const [refresh, setRefresh] = useState(0);
  const [now, setNow] = useState(Date.now);
  const [loaded, setLoaded] = useState<Loaded>({ client: null, account: null, records: [], names: new Map(), state: "loading" });
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    let live = true;
    setLoaded({ client: tcw, account: accountDid, records: [], names: new Map(), state: "loading" });
    if (!tcw || !accountDid) return () => { live = false; };
    // Reuse only this owner's cached connection labels; Ledger requests no Feed or SQL access.
    const cache = readLocal<{ sources?: { agentDid?: unknown; label?: unknown }[] }>(accountCacheKey(accountDid, "home-feed"));
    void Promise.all([loadLedger({ kv: tcw.space("applications").kv }), cache]).then(([records, cached]) => {
      const names = new Map<string, string>();
      const sources = cached?.value?.sources;
      if (Array.isArray(sources)) for (const source of sources) {
        if (source && typeof source.agentDid === "string" && typeof source.label === "string") names.set(source.agentDid.split("#", 1)[0]!, source.label);
      }
      if (live) {
        setNow(Date.now());
        setLoaded({ client: tcw, account: accountDid, records, names, state: "ready" });
      }
    }).catch(() => {
      if (live) setLoaded({ client: tcw, account: accountDid, records: [], names: new Map(), state: "failed" });
    });
    return () => { live = false; };
  }, [tcw, accountDid, refresh]);
  const current = loaded.client === tcw && loaded.account === accountDid;
  const rows = useMemo(() => current && accountDid ? foldLedger(loaded.records, now, loaded.names) : [], [loaded, current, accountDid, now]);
  return (
    <section className="flex h-full min-h-0 flex-col" aria-label="Ledger">
      <AppBar name="Ledger" glyph="tasks" accountDid={accountDid} pin={appPinId(LEDGER_APP_ID)} />
      {tcw && accountDid ? <LedgerView rows={rows} now={now} state={current ? loaded.state : "loading"} onRefresh={() => setRefresh((value) => value + 1)} />
        : <p className="p-8 text-body text-muted-foreground">Connect TinyCloud to see your ledger.</p>}
    </section>
  );
}
