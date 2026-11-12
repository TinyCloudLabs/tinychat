// The feed lab (lib/feedLab.ts): the real Home feed, HomeFeedEntries and everything
// it renders, on made-up cards held in memory (feedLabSource.ts), so card
// interactions can be tried without signing in. main.tsx loads it only in a
// build made with VITE_FEED_LAB=true. Not a product surface.
import { useEffect, useState } from "react";
import { Link, Navigate, Route, Routes } from "react-router-dom";
import { FEED_LAB_PATH } from "@/lib/feedLab";
import { HomeFeedEntries } from "./HomeFeedEntries";
import { createFeedLabSource } from "./feedLabSource";

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

export function FeedLab() {
  // Reset starts over: new cards, and a new feed with nothing chosen, typed or pending.
  const [lab, setLab] = useState(() => ({ run: 0, source: createFeedLabSource() }));
  useEffect(() => () => lab.source.stop(), [lab]);
  return <div className="flex h-dvh flex-col bg-background text-foreground">
    <header className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2 text-sm">
      <p className="min-w-0 flex-1"><span className="font-medium">Feed lab</span><span className="block text-xs text-muted-foreground">Made-up cards and a simulated agent. Nothing leaves this page.</span></p>
      <button type="button" onClick={() => setLab({ run: lab.run + 1, source: createFeedLabSource() })} className="min-h-11 rounded-lg border border-border px-3 text-sm fine:min-h-10">Reset</button>
      <Link to="/" className="inline-flex min-h-11 items-center underline underline-offset-2 fine:min-h-10">Close</Link>
    </header>
    <div className="min-h-0 flex-1"><HomeFeedEntries key={lab.run} source={lab.source} /></div>
    {/* Which build this is, so anyone can tell they are looking at the latest. */}
    <footer className="border-t border-border px-3 py-1 text-[11px] text-muted-foreground"><code>{buildStamp()}</code></footer>
  </div>;
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
