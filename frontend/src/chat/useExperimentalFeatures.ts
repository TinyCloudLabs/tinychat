import { useCallback, useEffect, useMemo, useState } from "react";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { getCanvasEnabled, setCanvasEnabled } from "../lib/conversationCanvasStore";
import type { BillingStatus } from "../lib/billingApi";

const CACHE_KEY = "tinychat:experimental:conversation-canvas";

/** Testing rollout: every signed-in account can opt in from Settings. */
export function isConversationCanvasEligible(_billingStatus: BillingStatus | null): boolean {
  return true;
}

export function useConversationCanvasFeature(tcw: TinyCloudWeb, billingStatus: BillingStatus | null) {
  const eligible = isConversationCanvasEligible(billingStatus);
  const [enabled, setEnabledState] = useState(false);
  const [loading, setLoading] = useState(true);
  const cacheKey = useMemo(() => `${CACHE_KEY}:${tcw.did ?? tcw.spaceId ?? "anonymous"}`, [tcw]);

  useEffect(() => {
    if (!eligible) { setEnabledState(false); setLoading(false); return; }
    try {
      const cached = window.localStorage.getItem(cacheKey);
      if (cached === "true") setEnabledState(true);
    } catch { /* optional instant paint */ }
    let cancelled = false;
    const onFeatureChange = (event: Event) => {
      const detail = (event as CustomEvent<{ key?: string; enabled?: boolean }>).detail;
      if (detail?.key === cacheKey && typeof detail.enabled === "boolean") setEnabledState(detail.enabled);
    };
    window.addEventListener("tinychat:experimental-feature", onFeatureChange);
    void getCanvasEnabled(tcw).then((value) => {
      if (!cancelled) setEnabledState(value);
    }).catch(() => {
      // Keep the local instant value if the capability is temporarily unavailable.
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; window.removeEventListener("tinychat:experimental-feature", onFeatureChange); };
  }, [cacheKey, eligible, tcw]);

  const setEnabled = useCallback(async (value: boolean) => {
    if (!eligible) return;
    setEnabledState(value);
    try { window.localStorage.setItem(cacheKey, String(value)); } catch { /* optional cache */ }
    window.dispatchEvent(new CustomEvent("tinychat:experimental-feature", { detail: { key: cacheKey, enabled: value } }));
    await setCanvasEnabled(tcw, value);
  }, [cacheKey, eligible, tcw]);

  return { eligible, enabled: eligible && enabled, loading, setEnabled };
}
