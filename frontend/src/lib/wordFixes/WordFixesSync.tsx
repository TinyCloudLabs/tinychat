// Keeps the shared word fixes list loaded for the signed-in space and fresh when the app returns to the foreground
// (TC-2199). Renders nothing.
import { useEffect } from "react";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { afterFeedFirst } from "../localFirst/requestLanes";
import { loadWordFixes } from "./wordFixesStore";

export function WordFixesSync({ tcw }: { tcw: TinyCloudWeb | null }) {
  useEffect(() => {
    if (tcw === null) { void loadWordFixes(null); return; }
    let live = true;
    // The Feed shows no word fixes: on a Feed open the read waits for the Feed's first load.
    void afterFeedFirst(async () => { if (live) await loadWordFixes(tcw); });
    const onVisible = () => { if (document.visibilityState === "visible") void loadWordFixes(tcw); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { live = false; document.removeEventListener("visibilitychange", onVisible); };
  }, [tcw]);
  return null;
}
