// Recording and Connectors on the Home site. The base sign-in grants neither, so each asks for its own set in place,
// when the owner opens it, through an injected requestFeatureAccess; nothing asks at boot. Off the Home site every
// feature is covered and permitted, and nothing here changes what renders.
import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { CONNECTORS_KV_PREFIX } from "@tinyboilerplate/core";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { Button } from "@/components/ui/button";
import { HOME_SITE } from "@/lib/homeSite";
import { readHomeFeatures, rememberHomeFeature, sessionCoversHomeFeature, type HomeFeature } from "@/lib/homeFeatures";
import {
  FEATURE_ACCESS_BODY, FEATURE_ACCESS_BUSY, FEATURE_ACCESS_CONTINUE, FEATURE_ACCESS_DECLINED, FEATURE_ACCESS_FAILED,
  FEATURE_ACCESS_NEEDED, FEATURE_ACCESS_NOT_NOW, FEATURE_ACCESS_TITLE, FEATURE_ACCESS_WRONG_ACCOUNT,
} from "@/lib/homeStrings";
import type { InFlightWork } from "@/lib/inFlightWork";

/** What asking for a feature's set came to. Only "granted" replaces the session. */
export type FeatureAccessOutcome = "granted" | "declined" | "failed" | "wrong-account" | "busy" | "signed-out";
export type RequestFeatureAccess = (feature: HomeFeature) => Promise<FeatureAccessOutcome>;

export interface HomeFeatureAccess {
  /** The session's own approval covers the feature's set: its screens may open and use it. */
  covered(feature: HomeFeature): boolean;
  /** Covered, and this device has used the feature: work that runs without the owner opening it may start. */
  permitted(feature: HomeFeature): boolean;
  /** Ask for the feature's set in place. */
  request: RequestFeatureAccess;
  /** The owner is in a covered feature: once one call needing its rights succeeds, remember it on this device. */
  confirmUse(feature: HomeFeature): void;
  /** Running work asking must not cut off. */
  inFlight: InFlightWork;
}

const EVERYTHING: HomeFeatureAccess = {
  covered: () => true,
  permitted: () => true,
  request: async () => "granted",
  confirmUse: () => {},
  inFlight: null,
};
// The Home site without a session: nothing is covered, and there is nothing to ask with.
const NOTHING: HomeFeatureAccess = {
  covered: () => false,
  permitted: () => false,
  request: async () => "failed",
  confirmUse: () => {},
  inFlight: null,
};

export const HomeFeatureAccessContext = createContext<HomeFeatureAccess>(HOME_SITE ? NOTHING : EVERYTHING);

export function useHomeFeatureAccess(): HomeFeatureAccess {
  return useContext(HomeFeatureAccessContext);
}

// A read under connectors/, which both sets grant. Found or not found, it answers only when the session's rights work.
const FIRST_USE_KEY = `${CONNECTORS_KV_PREFIX}/home-first-use`;

/** The Home site's feature access for the signed-in `tcw` and `address`. Off the Home site, everything. */
export function useHomeFeatureAccessState(options: {
  homeSite: boolean;
  tcw: (Partial<Pick<TinyCloudWeb, "hasPermissions">> & Pick<TinyCloudWeb, "kv">) | null;
  address: string | null;
  store: Pick<Storage, "getItem" | "setItem"> | null;
  requestFeatureAccess: RequestFeatureAccess;
  inFlight: InFlightWork;
}): HomeFeatureAccess {
  const { homeSite, tcw, address, store, requestFeatureAccess, inFlight } = options;
  // Bumped when a feature's flag is stored, so the flags are read again. A write the store refuses changes nothing,
  // so nothing reads again until the owner opens the feature again.
  const [remembered, setRemembered] = useState(0);
  const confirming = useRef(new Set<string>());
  const flags = useMemo(
    () => (homeSite && address ? readHomeFeatures(store, address) : []),
    [homeSite, address, store, remembered],
  );
  const coverage = useMemo(() => {
    if (!homeSite || !tcw || !address) return { recording: false, connectors: false };
    return {
      recording: sessionCoversHomeFeature(tcw, "recording", address),
      connectors: sessionCoversHomeFeature(tcw, "connectors", address),
    };
  }, [homeSite, tcw, address]);
  const confirmUse = useCallback((feature: HomeFeature) => {
    if (!homeSite || !tcw || !address || !coverage[feature] || flags.includes(feature)) return;
    const attempt = `${address}:${feature}`;
    if (confirming.current.has(attempt)) return;
    confirming.current.add(attempt);
    void tcw.kv.get(FIRST_USE_KEY).then(
      (result) => {
        if ((result.ok || result.error.code === "KV_NOT_FOUND") && rememberHomeFeature(store, address, feature)) {
          setRemembered((value) => value + 1);
        }
      },
      () => undefined,
    ).finally(() => { confirming.current.delete(attempt); });
  }, [homeSite, tcw, address, store, coverage, flags]);
  return useMemo(() => homeSite
    ? {
      covered: (feature) => coverage[feature],
      permitted: (feature) => coverage[feature] && flags.includes(feature),
      request: requestFeatureAccess,
      confirmUse,
      inFlight,
    }
    : EVERYTHING, [homeSite, coverage, flags, requestFeatureAccess, confirmUse, inFlight]);
}

/**
 * A feature's screen or Settings section: the content once the session covers its set, else the in-place ask. Opening
 * it on a covering session is one use: it confirms the rights once, not on every render.
 */
export function HomeFeatureGate({ feature, children }: { feature: HomeFeature; children: ReactNode }) {
  const access = useHomeFeatureAccess();
  const covered = access.covered(feature);
  const latest = useRef(access);
  latest.current = access;
  useEffect(() => { if (covered) latest.current.confirmUse(feature); }, [covered, feature]);
  return covered ? <>{children}</> : <HomeFeaturePrompt feature={feature} />;
}

type PromptPhase = "ask" | "asking" | "later" | "declined" | "failed" | "wrong-account" | "busy";

const OUTCOME_LINE: Partial<Record<PromptPhase, string>> = {
  declined: FEATURE_ACCESS_DECLINED,
  failed: FEATURE_ACCESS_FAILED,
  "wrong-account": FEATURE_ACCESS_WRONG_ACCOUNT,
  busy: FEATURE_ACCESS_BUSY,
};

/**
 * Asks for one feature's set. Nothing else on the page waits on it: the feed and chat keep working whatever it says.
 * Every outcome leaves Continue and Not now usable; the session only changes when the ask is granted and swapped in.
 */
export function HomeFeaturePrompt({ feature }: { feature: HomeFeature }) {
  const access = useHomeFeatureAccess();
  const [phase, setPhase] = useState<PromptPhase>("ask");
  const headingId = useId();
  const busy = access.inFlight !== null;
  const ask = async () => {
    setPhase("asking");
    const outcome = await access.request(feature).catch((): FeatureAccessOutcome => "failed");
    // Granted: the gate shows the feature once the new session covers it; if it does not, the ask starts over.
    setPhase(outcome === "granted" || outcome === "signed-out" ? "ask" : outcome);
  };
  const alert = OUTCOME_LINE[phase];
  return (
    <section aria-labelledby={headingId} data-testid={`feature-access-${feature}`} className="mx-auto my-6 flex w-full max-w-md flex-col gap-3 rounded-xl border bg-card p-5">
      <h2 id={headingId} className="text-base font-semibold">{FEATURE_ACCESS_TITLE[feature]}</h2>
      {alert
        ? <p role="alert" className="text-sm text-muted-foreground">{alert}</p>
        : <p className="text-sm text-muted-foreground">{phase === "later" ? FEATURE_ACCESS_NEEDED[feature] : FEATURE_ACCESS_BODY[feature]}</p>}
      {busy && phase !== "busy" && <p className="text-sm text-muted-foreground">{FEATURE_ACCESS_BUSY}</p>}
      <div className="flex items-center gap-2">
        <Button className="rounded-full" disabled={busy || phase === "asking"} onClick={() => void ask()}>
          {FEATURE_ACCESS_CONTINUE}
        </Button>
        {phase !== "later" && (
          <Button variant="ghost" onClick={() => setPhase("later")}>{FEATURE_ACCESS_NOT_NOW}</Button>
        )}
      </div>
    </section>
  );
}
