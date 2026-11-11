// The feed lab (lib/feedLab.ts): the real Home feed, HomeFeedEntries and everything
// it renders, on made-up cards held in memory (feedLabSource.ts), so card
// interactions can be tried without signing in. main.tsx loads it only in a
// build made with VITE_FEED_LAB=true. Not a product surface.
import { useEffect, useState } from "react";
import { Link, Navigate, Route, Routes } from "react-router-dom";
import { FEED_LAB_PATH } from "@/lib/feedLab";
import { HomeFeedEntries } from "./HomeFeedEntries";
import { createFeedLabSource } from "./feedLabSource";

export function FeedLab() {
  // Reset starts over: new cards, and a new feed with nothing chosen, typed or pending.
  const [lab, setLab] = useState(() => ({ run: 0, source: createFeedLabSource() }));
  useEffect(() => () => lab.source.stop(), [lab]);
  return <div className="flex h-dvh flex-col bg-background text-foreground">
    <header className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2 text-sm">
      <p className="min-w-0 flex-1"><span className="font-medium">Feed lab</span><span className="block text-xs text-muted-foreground">Made-up cards and a simulated agent. Nothing leaves this page.</span></p>
      <button type="button" onClick={() => setLab({ run: lab.run + 1, source: createFeedLabSource() })} className="min-h-10 rounded-lg border border-border px-3 text-sm">Reset</button>
      <Link to="/" className="inline-flex min-h-10 items-center underline underline-offset-2">Close</Link>
    </header>
    <div className="min-h-0 flex-1"><HomeFeedEntries key={lab.run} source={lab.source} /></div>
  </div>;
}

/** What main.tsx mounts for an address the app does not know, in a lab build: the lab at its own, home for the rest. */
export default function FeedLabRoutes() {
  return <Routes>
    <Route path={FEED_LAB_PATH} element={<FeedLab />} />
    <Route path="*" element={<Navigate to="/" replace />} />
  </Routes>;
}
