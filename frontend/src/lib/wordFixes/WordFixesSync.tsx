// Keeps the shared word fixes list loaded for the signed-in space and fresh when the app returns to the foreground
// (TC-2199). Renders nothing.
import { useEffect } from "react";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { loadWordFixes } from "./wordFixesStore";

export function WordFixesSync({ tcw }: { tcw: TinyCloudWeb | null }) {
  useEffect(() => {
    void loadWordFixes(tcw);
    if (tcw === null) return;
    const onVisible = () => { if (document.visibilityState === "visible") void loadWordFixes(tcw); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { document.removeEventListener("visibilitychange", onVisible); };
  }, [tcw]);
  return null;
}
