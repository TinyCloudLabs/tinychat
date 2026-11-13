// The feed lab (lib/feedLab.ts): the real Home feed, HomeFeedEntries and everything
// it renders, on made-up cards held in memory (feedLabSource.ts), so card
// interactions can be tried without signing in. It can also show a test feed's
// export (feedLabJsonSource.ts), from `?src=<https URL>` or pasted. main.tsx loads it
// only in a build made with VITE_FEED_LAB=true. Not a product surface.
import { useEffect, useState } from "react";
import { Link, Navigate, Route, Routes, useSearchParams } from "react-router-dom";
import { UploadIcon } from "lucide-react";
import { FEED_LAB_PATH } from "@/lib/feedLab";
import { HomeFeedEntries } from "./HomeFeedEntries";
import { createFeedLabJsonSource } from "./feedLabJsonSource";
import { createFeedLabSource } from "./feedLabSource";
import type { HomeFeedSource } from "./feedStoreTypes";

// The lab is served over plain http on the tailnet, where browsers withhold crypto.randomUUID (secure contexts
// only). Every id the feed makes goes through it, so the lab supplies the same v4 shape from getRandomValues,
// which every context has.
if (typeof crypto.randomUUID !== "function") {
  Object.defineProperty(crypto, "randomUUID", {
    configurable: true,
    value: () => {
      const bytes = crypto.getRandomValues(new Uint8Array(16));
      bytes[6] = (bytes[6]! & 0x0f) | 0x40;
      bytes[8] = (bytes[8]! & 0x3f) | 0x80;
      const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    },
  });
}

/** `exportedAt`: set when the feed is a test feed's export. */
interface Lab { run: number; source: HomeFeedSource & { stop(): void }; exportedAt?: string }
const buttonClass = "min-h-11 rounded-lg border border-border px-3 text-sm fine:min-h-10";

export function FeedLab() {
  const [params, setParams] = useSearchParams();
  const src = params.get("src");
  // Reset starts over: new cards, and a new feed with nothing chosen, typed or pending. With `?src=`, the test feed
  // loads first; the made-up cards wait behind it.
  const [lab, setLab] = useState<Lab | null>(() => src ? null : { run: 0, source: createFeedLabSource() });
  const [error, setError] = useState<string | null>(null);
  const [pasting, setPasting] = useState(false);
  const [pasted, setPasted] = useState("");
  useEffect(() => () => lab?.source.stop(), [lab]);

  const show = (data: unknown) => {
    const source = createFeedLabJsonSource(data);
    setLab((current) => ({ run: (current?.run ?? 0) + 1, source, exportedAt: source.exportedAt }));
    setError(null);
  };
  const fail = (problem: unknown) => {
    setError(problem instanceof Error ? problem.message : String(problem));
    setLab((current) => current ?? { run: 0, source: createFeedLabSource() });
  };
  useEffect(() => {
    if (!src) return;
    const controller = new AbortController();
    void (async () => {
      const url = new URL(src);
      if (url.protocol !== "https:") throw new Error("only https addresses can be loaded");
      const response = await fetch(url, { signal: controller.signal, cache: "no-store" });
      if (!response.ok) throw new Error(`the server answered ${response.status}`);
      const data: unknown = await response.json();
      if (!controller.signal.aborted) show(data);
    })().catch((problem: unknown) => { if (!controller.signal.aborted) fail(problem); });
    return () => controller.abort();
  }, [src]);
  // A pasted feed or Reset replaces the address's feed, so reloading shows what is on screen.
  const dropSrc = () => { if (src) setParams((current) => { current.delete("src"); return current; }, { replace: true }); };
  const loadPasted = () => {
    try {
      show(JSON.parse(pasted));
      dropSrc(); setPasting(false); setPasted("");
    } catch (problem) { fail(problem); }
  };
  const reset = () => {
    dropSrc(); setError(null);
    setLab((current) => ({ run: (current?.run ?? 0) + 1, source: createFeedLabSource() }));
  };

  const active = !lab ? "Loading test feed…" : lab.exportedAt === undefined ? "Made-up cards" : `Test feed · ${exportStamp(lab.exportedAt)}`;
  return <div className="flex h-dvh flex-col bg-background text-foreground">
    {/* One line at a phone's width (design round 6): the subtitle shows from 640px, Load JSON is an icon. */}
    <header className="flex items-center gap-2 border-b border-border px-3 py-1.5 text-sm">
      <p className="min-w-0 flex-1"><span className="block truncate font-medium">Feed lab · {active}</span><span className="hidden text-xs text-muted-foreground sm:block">{lab?.exportedAt === undefined ? "A simulated agent answers. Nothing leaves this page." : "Cards from a test feed's export. Nothing you do here is sent."}</span></p>
      <button type="button" onClick={() => setPasting(!pasting)} aria-expanded={pasting} aria-label="Load JSON" title="Load JSON" className="flex size-11 shrink-0 items-center justify-center rounded-lg border border-border fine:size-9"><UploadIcon aria-hidden className="size-4" /></button>
      <button type="button" onClick={reset} className={`${buttonClass} shrink-0`}>Reset</button>
      <Link to="/" className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center underline underline-offset-2 fine:min-h-10">Close</Link>
    </header>
    {pasting && <div className="flex flex-col gap-2 border-b border-border px-3 py-2 text-sm">
      <textarea value={pasted} onChange={(event) => setPasted(event.target.value)} aria-label="Feed export JSON" placeholder="Paste a test feed's export JSON" rows={6} className="w-full rounded-lg border border-border bg-background p-2 font-mono text-xs" />
      <div className="flex gap-2">
        <button type="button" onClick={loadPasted} disabled={!pasted.trim()} className={`${buttonClass} disabled:opacity-50`}>Load</button>
        <button type="button" onClick={() => { setPasting(false); setPasted(""); }} className={buttonClass}>Cancel</button>
      </div>
    </div>}
    {error && <p role="alert" className="border-b border-border px-3 py-1 text-xs text-destructive">Couldn't load that feed: {error}. Check the export and paste it again.</p>}
    <div className="min-h-0 flex-1">{lab && <HomeFeedEntries key={lab.run} source={lab.source} />}</div>
    {/* Which build this is, so anyone can tell they are looking at the latest. */}
    <footer className="border-t border-border px-3 py-1 text-[11px] text-muted-foreground"><code>{buildStamp()}</code></footer>
  </div>;
}

/** "2026-11-12 22:20 UTC" for an ISO time; anything else as written. */
function exportStamp(at: string) {
  const time = Date.parse(at);
  return Number.isNaN(time) ? at : `${new Date(time).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** "Build 311daa1 · 2026-11-12 22:20 UTC": the commit and time this build was made. */
function buildStamp() {
  const commit = (typeof __EXO_BUILD_INFO__ === "object" && __EXO_BUILD_INFO__?.commit?.slice(0, 7)) || "unknown";
  const at = typeof __FEED_LAB_BUILT_AT__ === "string" ? `${__FEED_LAB_BUILT_AT__.slice(0, 10)} ${__FEED_LAB_BUILT_AT__.slice(11, 16)} UTC` : "unknown time";
  return `Build ${commit} · ${at}`;
}

/** What main.tsx mounts for an address the app does not know, in a lab build: the lab at its own, home for the rest. */
export default function FeedLabRoutes() {
  return <Routes>
    <Route path={FEED_LAB_PATH} element={<FeedLab />} />
    <Route path="*" element={<Navigate to="/" replace />} />
  </Routes>;
}
