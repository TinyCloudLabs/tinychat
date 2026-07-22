import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { AssistantRuntimeProvider } from "@assistant-ui/react";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import {
  SessionStore,
  clearPersistedSession,
  connectWallet,
  createAndSignIn,
  createApiClient,
  loadAppManifest,
  requestNonce,
  restoreTinyCloudWebSession,
  verifySession,
} from "@tinyboilerplate/client";
import { useVisualViewportFit } from "./lib/useVisualViewport";
import { useChatRuntime } from "./chat/runtime";
import { Thread } from "./chat/Thread";
import { ThreadList } from "./chat/ThreadList";
import { useAgentEnablement } from "./chat/useAgentEnablement";
import { AgentEnablementBanner } from "./chat/AgentEnablementBanner";
import { PricingDialog } from "./chat/PricingDialog";
import { RatesDialog } from "./chat/RatesDialog";
import {
  DEFAULT_MODEL,
  appendCompaction,
  getLatestCompaction,
  getSetting,
  readMemoryCache,
  setSetting,
} from "./lib/threadStore";
import { completeChat, type ChatMessage } from "./lib/chatApi";
import { COMPACTION_SUMMARY_MAX_TOKENS, DEFAULT_CONTEXT_TOKENS } from "./chat/compaction";
import { loadSharedThreadFromToken, readShareTokenFromLocation } from "./lib/tinychatShareLinks";
import { historyPrefetch } from "./lib/historyPrefetch";
import {
  aggregateTurnCredits,
  createBillingClient,
  formatCredits,
  getCachedRates,
  type BillingClient,
  type BillingConfig,
  type BillingStatus,
} from "./lib/billingApi";
import {
  emitReceipt,
  onBillingEvent,
  onModelSelectionError,
  onPaywallError,
} from "./lib/chatApi";
import { isPaywallActionable } from "./lib/paywall";
import {
  fetchConfigWithRetry,
  shouldRefetch,
  type RefetchTrigger,
} from "./lib/billingConfigPolicy";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { SettingsPage } from "./chat/SettingsPage";
import { ModelVerificationIndicator } from "./chat/ModelVerificationIndicator";
import { PanelLeftIcon, SettingsIcon } from "lucide-react";
import { healPersistedModel, sanitizeModel } from "./lib/sanitizeModel";
import { clearAgentSessionCache } from "./lib/agentDelegation";
import { onAgentPaywallError, onAgentModelSelectionError } from "./lib/agentChatApi";
import type { ThreadDoc, StoredMessageItem } from "./lib/threadStore";

const OPENKEY_HOST = import.meta.env.VITE_OPENKEY_HOST || "https://openkey.so";
const APP_NAME = "TinyCloud Chat";
const BACKEND_URL =
  import.meta.env.VITE_BACKEND_URL ||
  `${globalThis.location?.protocol ?? "http:"}//localhost:3014`;
const MODEL_STORAGE_KEY = "xyz.tinycloud.tinychat:active-model";
// Empty offered-set sentinel for the pre-/models-load sanitize path (ST1).
const EMPTY_OFFERED: ReadonlySet<string> = new Set();

function getInitialModel(): string {
  if (typeof window === "undefined") return DEFAULT_MODEL;
  try {
    // ST1 — heal a stale persisted id on first paint. The /models list isn't
    // loaded yet, so sanitizeModel falls back to the phala/ prefix gate (a
    // non-phala legacy id is rejected; a phala id is kept for instant paint).
    return sanitizeModel(window.localStorage.getItem(MODEL_STORAGE_KEY), EMPTY_OFFERED);
  } catch {
    return DEFAULT_MODEL;
  }
}

export type AppState =
  | "booting"
  | "unauthenticated"
  | "connecting"
  | "signing"
  | "ready"
  | "recoverableError";

interface ModelOption {
  id: string;
  /** When the paywall is on, whether the current tier may use this model. */
  allowed?: boolean;
  requiredTier?: "plus" | "pro";
  /** Per-model credit rates (spec §5.4 — always present from /api/chat/models). */
  creditsPerKInput: number;
  creditsPerKOutput: number;
  multiplier: number;
  /**
   * Context window in tokens (spec §D.4). Plumbed from /api/chat/models so the
   * adapter can size compaction; absent → DEFAULT_CONTEXT_TOKENS via
   * contextTokensFor below.
   */
  contextLength?: number;
}

export function App() {
  // Track the visible viewport so the shell shrinks above the soft keyboard
  // instead of letting it cover the composer (iOS Safari `100dvh` does not).
  useVisualViewportFit();
  const initialModel = getInitialModel();
  const initialShareToken = useMemo(() => readShareTokenFromLocation(), []);
  const sessionStoreRef = useRef(new SessionStore("xyz.tinycloud.tinychat:session"));
  const restoredRef = useRef(false);
  const modelRef = useRef<string>(initialModel);
  // Live ref the runtime reads at model-context request time. Initialized to
  // null and reconciled by useChatRuntime + MemoryPanel from the per-space
  // memory row. Held at App level (above useChatRuntime) so the MemoryPanel
  // and runtime share one source of truth.
  const memoryRef = useRef<string | null>(null);

  const [state, setState] = useState<AppState>("booting");
  const [address, setAddress] = useState<string | null>(null);
  const [did, setDid] = useState<string | null>(null);
  const [spaceId, setSpaceId] = useState<string | null>(null);
  const [tcw, setTcw] = useState<TinyCloudWeb | null>(null);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [model, setModel] = useState<string>(initialModel);
  const [error, setError] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const offeredModelsRef = useRef<ModelOption[]>([]);
  // Live set of offered model ids — the request-path/per-thread heal source of
  // truth (Bug #1). Kept in sync with `models` alongside offeredModelsRef.
  const offeredModelIdsRef = useRef<ReadonlySet<string>>(EMPTY_OFFERED);
  const restoredActiveModelForTcwRef = useRef<TinyCloudWeb | null>(null);

  // ── Billing / paywall state ──────────────────────────────────────
  // config is fetched once on load (public, cached); status is fetched after
  // sign-in and refreshed on dialog-open. Checkout + subscription management
  // live in the account app now (opened in a new tab from the pricing dialog).
  // All paywall UI is gated on `billingConfig?.paywallEnabled` — when the backend
  // reports the paywall off (or before config loads) nothing renders.
  const billingRef = useRef<BillingClient>(
    createBillingClient(BACKEND_URL, sessionStoreRef.current),
  );
  const [billingConfig, setBillingConfig] = useState<BillingConfig | null>(null);
  const [billingStatus, setBillingStatus] = useState<BillingStatus | null>(null);
  // A1 — refs mirror the config-fetch policy inputs so the trigger callbacks
  // (settings entry / 402 / focus) read the live state without stale closures.
  const billingConfigRef = useRef<BillingConfig | null>(null);
  const initialFetchFailedRef = useRef(false);
  // Guards against overlapping config requests (initial retry + a trigger, or
  // two triggers) — bounded + only-when-null already, this makes it storm-proof.
  const configFetchInFlightRef = useRef(false);
  const [pricingOpen, setPricingOpen] = useState(false);
  const [ratesOpen, setRatesOpen] = useState(false);
  const [billingNotice, setBillingNotice] = useState<string | null>(null);
  const [shareToken, setShareToken] = useState<string | null>(initialShareToken);
  const paywallEnabled = billingConfig?.paywallEnabled === true;
  const openRates = useCallback(() => setRatesOpen(true), []);

  const refreshBillingStatus = useCallback(async () => {
    try {
      const status = await billingRef.current.getStatus();
      setBillingStatus(status);
    } catch {
      // status is optional UI; a failure just leaves the indicator unpopulated.
    }
  }, []);
  // Soft refresh after an import: bumping this key remounts the inner runtime
  // tree so useChatRuntime re-runs listThreads() cold. The dialog already
  // clears the index cache, so this avoids window.location.reload while still
  // surfacing imported rows. Header state (model picker, memory popover) and
  // the auth session survive the bump because they live above ChatWorkspace.
  const [importRefreshKey, setImportRefreshKey] = useState(0);
  const onImported = useCallback(() => {
    setSidebarOpen(false);
    setImportRefreshKey((k) => k + 1);
  }, []);
  const onMemoryUpdated = useCallback((_doc: string | null) => {}, []);

  const setSelectedModel = useCallback((next: string) => {
    modelRef.current = next;
    setModel(next);
  }, []);

  // localStorage is an instant-paint cache for the picker; the per-space SQL
  // `settings` row (active_model) is the cross-device source of truth.
  const writeLocalModel = useCallback((next: string) => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(MODEL_STORAGE_KEY, next);
    } catch {
      // localStorage full/disabled — the cache is optional.
    }
  }, []);

  // Explicit dropdown pick: update state, cache locally (instant), and persist to
  // the user's TinyCloud space (async, syncs across devices). The per-thread sync
  // (onActiveThreadModel) uses setSelectedModel directly and does NOT overwrite
  // this global default.
  const pickModel = useCallback(
    (next: string) => {
      setSelectedModel(next);
      writeLocalModel(next);
      if (tcw) {
        void setSetting(tcw, "active_model", next).catch((err) => {
          console.warn("[App] failed to persist model selection to space", err);
        });
      }
    },
    [setSelectedModel, writeLocalModel, tcw],
  );

  useEffect(() => {
    offeredModelsRef.current = models;
    offeredModelIdsRef.current = new Set(models.map((m) => m.id));
  }, [models]);

  // Context window (tokens) for a model id, read from the live offered catalog
  // (§D.4). Stable callback over a ref so it can be threaded into the runtime
  // deps without re-memoizing on every model-list change. Falls back to
  // DEFAULT_CONTEXT_TOKENS when the model carries no contextLength.
  const contextTokensFor = useCallback((modelId: string): number => {
    const found = offeredModelsRef.current.find((m) => m.id === modelId);
    return typeof found?.contextLength === "number" && found.contextLength > 0
      ? found.contextLength
      : DEFAULT_CONTEXT_TOKENS;
  }, []);

  const remediateUnavailableModel = useCallback(() => {
    const offered = new Set(offeredModelsRef.current.map((m) => m.id));
    const before = modelRef.current;
    const corrected = sanitizeModel(before, offered);
    if (corrected !== before) {
      pickModel(corrected);
      setBillingNotice("Switched to a verifiable model.");
      return;
    }
    setBillingNotice("That model is not available.");
  }, [pickModel]);

  // On sign-in, reconcile the picker with the cross-device default from the
  // user's space (SQL is the source of truth). localStorage already painted the
  // picker instantly; this updates it if another device changed the preference.
  useEffect(() => {
    if (state !== "ready" || !tcw) return;
    if (restoredActiveModelForTcwRef.current === tcw) return;
    restoredActiveModelForTcwRef.current = tcw;
    let cancelled = false;
    (async () => {
      try {
        const saved = await getSetting(tcw, "active_model");
        if (cancelled || !saved) return;
        // ST1 — validate the restored value against the offered catalog. A stale
        // non-offered id heals to DEFAULT_MODEL and the correction is persisted
        // back (SQL + localStorage) via pickModel so it does NOT recur next
        // sign-in — even when the corrected value already matches the picker.
        const offered = new Set(offeredModelsRef.current.map((m) => m.id));
        const { model: corrected, healed } = healPersistedModel(saved, offered);
        if (healed) {
          pickModel(corrected);
        } else if (saved !== modelRef.current) {
          setSelectedModel(saved);
          writeLocalModel(saved);
        }
      } catch (err) {
        // AUTH_UNAUTHORIZED or unset — keep the localStorage/default value.
        console.warn("[App] failed to load model selection from space", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [state, tcw, pickModel, setSelectedModel, writeLocalModel]);

  // Seed memoryRef from the localStorage cache as soon as we have a tcw —
  // before the first chat turn — so the very first injection paints from
  // cache and the runtime's SQL reconcile updates it asynchronously.
  useEffect(() => {
    if (!tcw) return;
    const cached = readMemoryCache(tcw);
    if (cached !== null && memoryRef.current === null) {
      memoryRef.current = cached;
    }
  }, [tcw]);

  // Close the mobile drawer when the viewport crosses into md+ so the Radix
  // overlay (a portal sibling not covered by md:hidden on SheetContent) can't
  // linger as a full-screen backdrop after a resize-while-open.
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mql = window.matchMedia("(min-width: 768px)");
    const handler = (event: MediaQueryListEvent | MediaQueryList) => {
      if (event.matches) setSidebarOpen(false);
    };
    handler(mql);
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, []);

  // Restore an existing session on boot (both Bearer token AND tcw for KV).
  useEffect(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;
    const sessionStore = sessionStoreRef.current;

    if (!sessionStore.hasSession() || sessionStore.isExpired()) {
      setState("unauthenticated");
      return;
    }
    const storedAddress = sessionStore.getAddress();
    const token = sessionStore.getToken();
    if (!storedAddress || !token) {
      sessionStore.clear();
      setState("unauthenticated");
      return;
    }

    (async () => {
      try {
        const restored = await restoreTinyCloudWebSession(storedAddress, {
          autoCreateSpace: false,
        });
        if (restored.status !== "restored" || !restored.tcw) {
          sessionStore.clear();
          setState("unauthenticated");
          return;
        }
        setTcw(restored.tcw);
        setAddress(storedAddress);
        setDid(restored.tcw.did ?? `did:pkh:eip155:1:${storedAddress}`);
        setSpaceId(restored.tcw.spaceId ?? null);
        setState("ready");
      } catch (caught) {
        sessionStore.clear();
        setError(errorMessage(caught));
        setState("recoverableError");
      }
    })();
  }, []);

  // A1 — keep the policy-input refs in sync with render state.
  useEffect(() => {
    billingConfigRef.current = billingConfig;
  }, [billingConfig]);

  // Re-request the config for a trigger, but ONLY while it is still null
  // (shouldRefetch). A held config is never re-fetched — no polling, no focus
  // storms. Each trigger refetch is a single attempt (the trigger IS the
  // retry); the initial mount fetch does the bounded backoff. Storm-guarded so
  // overlapping triggers can't fan out concurrent requests.
  const refetchConfigOnTrigger = useCallback((trigger: RefetchTrigger) => {
    if (
      !shouldRefetch(
        {
          config: billingConfigRef.current,
          initialFetchFailed: initialFetchFailedRef.current,
        },
        trigger,
      )
    ) {
      return;
    }
    if (configFetchInFlightRef.current) return;
    configFetchInFlightRef.current = true;
    void (async () => {
      try {
        const cfg = await fetchConfigWithRetry(
          () => billingRef.current.getConfig(),
          { maxAttempts: 1 },
        );
        // Only adopt it if we still hold nothing (avoid clobbering a config that
        // landed meanwhile).
        if (cfg && billingConfigRef.current === null) setBillingConfig(cfg);
      } finally {
        configFetchInFlightRef.current = false;
      }
    })();
  }, []);

  // Fetch the billing config on load (public, no auth) with a bounded, backed-off
  // retry so a single transient failure can't darken monetization for the whole
  // session. Cached on success. If every attempt still fails we record that and
  // keep the current "treat the paywall as off" behavior — the trigger refetches
  // (settings entry / 402 / focus) below can still recover it later.
  useEffect(() => {
    let cancelled = false;
    configFetchInFlightRef.current = true;
    (async () => {
      const cfg = await fetchConfigWithRetry(() => billingRef.current.getConfig());
      configFetchInFlightRef.current = false;
      if (cancelled) return;
      if (cfg) {
        setBillingConfig(cfg);
      } else {
        initialFetchFailedRef.current = true;
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // A1 trigger (c): window regains focus after a failed initial fetch. Gated by
  // shouldRefetch to null + initialFetchFailed, so a held config is never
  // re-fetched here. Event-driven (no interval) — nothing is left polling.
  useEffect(() => {
    const onFocus = () => refetchConfigOnTrigger("window-focus");
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refetchConfigOnTrigger]);

  // Fetch billing status after sign-in (only when the paywall is on).
  useEffect(() => {
    if (state !== "ready" || !paywallEnabled) return;
    void refreshBillingStatus();
  }, [state, paywallEnabled, refreshBillingStatus]);

  // Optimistically bump the usage chip when a receipt event fires — avoids
  // a per-message status refetch. Real reconciliation happens on dialog-open
  // and 402. Skips silently before status loads.
  useEffect(() => {
    return onBillingEvent((event) => {
      if (event.type !== "receipt") return;
      setBillingStatus((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          usage: { ...prev.usage, used: prev.usage.used + event.credits },
        };
      });
    });
  }, []);

  // Listen for paywall (402) errors thrown from the chat stream. The human
  // message still renders in-chat via ErrorPrimitive; here we additionally
  // refresh status and auto-open the pricing dialog so there's a clear upgrade
  // path. Active regardless of `paywallEnabled` — a 402 only fires when the
  // backend is enforcing the paywall.
  useEffect(() => {
    return onPaywallError((payload) => {
      // A1 trigger (b): a 402 means the backend is enforcing the paywall — if a
      // transient failure left us config-null, recover it now so the pricing
      // dialog can actually mount (no-op when a config is already held).
      refetchConfigOnTrigger("paywall-402");
      // ST3 — branch on the error so we only open the pricing dialog when an
      // upgrade can actually resolve the 402. `credit_budget_exceeded` and a
      // `model_not_allowed` carrying a higher `requiredTier` are upgrade-fixable.
      const actionable = isPaywallActionable(payload);
      if (actionable) {
        void refreshBillingStatus();
        setPricingOpen(true);
        return;
      }
      // A `model_not_allowed` with no actionable requiredTier cannot be fixed by
      // upgrading (every tier shares the phala/* namespace). Reset to a
      // verifiable model and surface a brief notice instead of an un-fixable dialog.
      remediateUnavailableModel();
    });
  }, [refreshBillingStatus, remediateUnavailableModel, refetchConfigOnTrigger]);

  useEffect(() => {
    return onModelSelectionError(() => {
      remediateUnavailableModel();
    });
  }, [remediateUnavailableModel]);

  // Mirror the paywall + model-selection subscriptions for the agent path.
  // agentChatApi.ts emits these because chatApi.ts's emitters are module-private.
  useEffect(() => {
    return onAgentPaywallError((payload) => {
      // A1 trigger (b): recover a config-null session on a 402 (see above).
      refetchConfigOnTrigger("paywall-402");
      const actionable = isPaywallActionable(payload);
      if (actionable) {
        void refreshBillingStatus();
        setPricingOpen(true);
        return;
      }
      remediateUnavailableModel();
    });
  }, [refreshBillingStatus, remediateUnavailableModel, refetchConfigOnTrigger]);

  useEffect(() => {
    return onAgentModelSelectionError(() => {
      remediateUnavailableModel();
    });
  }, [remediateUnavailableModel]);

  // Auto-dismiss the success notice.
  useEffect(() => {
    if (!billingNotice) return;
    const t = window.setTimeout(() => setBillingNotice(null), 5000);
    return () => window.clearTimeout(t);
  }, [billingNotice]);

  const openPricing = useCallback(() => {
    void refreshBillingStatus();
    setPricingOpen(true);
  }, [refreshBillingStatus]);

  // Load the model list once we have a backend token.
  useEffect(() => {
    if (state !== "ready") return;
    const api = createApiClient(BACKEND_URL, { sessionStore: sessionStoreRef.current });
    let cancelled = false;
    (async () => {
      try {
        const result = await api.get<{ models: ModelOption[] }>("/api/chat/models");
        if (cancelled) return;
        const list = result.models ?? [];
        setModels(list);
        if (list.length > 0) {
          // ST1 — validate the active id against the freshly-loaded offered list
          // and heal a stale value, persisting the correction back (SQL +
          // localStorage) via pickModel so it does not recur. Keep DEFAULT_MODEL
          // when present, otherwise the first available model.
          const offered = new Set(list.map((m) => m.id));
          const fallback = list.find((m) => m.id === DEFAULT_MODEL)?.id ?? list[0]!.id;
          const corrected = sanitizeModel(modelRef.current, offered, fallback);
          if (corrected !== modelRef.current) {
            pickModel(corrected);
          }
        }
      } catch {
        // Models endpoint optional for chatting; default model still works.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [state, pickModel]);

  const signIn = useCallback(async () => {
    setError(null);
    try {
      setState("connecting");
      const { address: connectedAddress, web3Provider } = await connectWallet({
        appName: APP_NAME,
        host: OPENKEY_HOST,
      });
      setAddress(connectedAddress);

      const [nonce, manifest] = await Promise.all([
        requestNonce(BACKEND_URL, connectedAddress),
        loadAppManifest(`${BACKEND_URL}/api/manifest`),
      ]);

      setState("signing");
      // setupSpaceSession + ensureSpaceExists happen inside the SDK when
      // autoCreateSpace is true; the manifest grants tinycloud.kv on the space.
      const { tcw: signedTcw, session } = await createAndSignIn(web3Provider, {
        address: connectedAddress,
        nonce,
        autoCreateSpace: true,
        manifest,
      });

      // Exchange the SIWE message for a backend Bearer token (for /api/chat).
      const verified = await verifySession(BACKEND_URL, session.siwe, session.signature);
      sessionStoreRef.current.setSession(verified.token, verified.expiresIn, connectedAddress);

      setTcw(signedTcw);
      setDid(signedTcw.did ?? null);
      setSpaceId(signedTcw.spaceId ?? null);
      setState("ready");
    } catch (caught) {
      setError(errorMessage(caught));
      setState("recoverableError");
    }
  }, []);

  const signOut = useCallback(async () => {
    if (tcw) await tcw.signOut?.();
    else if (address) clearPersistedSession(address);
    sessionStoreRef.current.clear();
    // Drop the in-memory history prefetch cache and stop its queue — it holds
    // the signed-out account's message docs.
    historyPrefetch.clear();
    // Clear the agent session cache so the next sign-in re-probes.
    clearAgentSessionCache();
    if (typeof window !== "undefined") {
      try {
        window.localStorage.removeItem(MODEL_STORAGE_KEY);
      } catch {
        // localStorage disabled — nothing to clear.
      }
    }
    modelRef.current = DEFAULT_MODEL;
    restoredActiveModelForTcwRef.current = null;
    memoryRef.current = null;
    setModel(DEFAULT_MODEL);
    setTcw(null);
    setAddress(null);
    setDid(null);
    setSpaceId(null);
    setModels([]);
    setBillingStatus(null);
    setPricingOpen(false);
    setState("unauthenticated");
  }, [address, tcw]);

  const isReady = state === "ready" && tcw !== null;

  const navigate = useNavigate();
  const location = useLocation();
  const showSettings = location.pathname.endsWith("/chat/settings");

  // Belt-and-suspenders guard: if the user lands on (or is on) /chat/settings
  // while signed out (post-signOut flip, deep link, etc.), kick them to /chat.
  // SettingsPage only renders inside the isReady branch below, so this is the
  // sole place the URL gets normalized.
  useEffect(() => {
    if (!isReady && showSettings) {
      navigate("/chat", { replace: true });
    }
  }, [isReady, showSettings, navigate]);

  // A1 trigger (a): entering the settings page recovers a config-null session
  // (the Plan & Usage card lives there). No-op when a config is already held.
  useEffect(() => {
    if (showSettings) refetchConfigOnTrigger("settings-entry");
  }, [showSettings, refetchConfigOnTrigger]);

  // Prefer history-back so the previous chat scroll/composer focus restores
  // naturally; fall back to /chat when there's no in-app history (deep link or
  // refresh on /chat/settings). react-router v7 stamps `idx` on history state.
  const onBack = useCallback(() => {
    const idx = (window.history.state as { idx?: number } | null)?.idx;
    if (typeof idx === "number" && idx > 0) {
      navigate(-1);
    } else {
      navigate("/chat");
    }
  }, [navigate]);

  return (
    <div
      className="flex flex-col bg-background text-foreground pt-[env(safe-area-inset-top)]"
      style={{ height: "var(--tc-app-height, 100dvh)" }}
    >
      <header className="flex items-center justify-between gap-1.5 border-b border-border px-3 py-2.5 sm:gap-3 sm:px-4">
        <div className="flex items-center gap-1.5 sm:gap-3">
          {isReady && (
            <Button
              variant="outline"
              size="sm"
              aria-label="Open chat list"
              onClick={() => setSidebarOpen(true)}
              className="h-11 w-11 p-0 md:hidden"
            >
              <PanelLeftIcon className="size-4" />
            </Button>
          )}
          <span className="flex items-center gap-2 text-sm font-semibold tracking-tight">
            <span className="flex size-6 items-center justify-center rounded-md bg-primary text-xs font-bold text-primary-foreground">
              T
            </span>
            <span className="hidden sm:inline">TinyCloud Chat</span>
          </span>
          {isReady && (
            // Intentionally hidden below the `sm` breakpoint: the header is
            // space-constrained on mobile and the per-message badge still
            // surfaces verification there. Desktop shows the model-level pill.
            <span className="hidden sm:inline-flex">
              <ModelVerificationIndicator model={model} />
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5 sm:gap-2">
          {isReady && paywallEnabled && (
            // A2 — render the chip on mobile too. The chip already degrades to a
            // compact tier label under `sm` (the usage numbers + bar are
            // `hidden sm:*` inside UsageIndicator), so this surfaces the
            // tier/usage affordance on narrow viewports without a redesign and
            // without crowding the header (the attestation pill stays
            // `hidden sm:inline-flex`).
            <UsageIndicator
              status={billingStatus}
              onClick={openPricing}
              onOpenRates={openRates}
            />
          )}
          <span className="hidden sm:inline-flex">
            <ThemeToggle />
          </span>
          {isReady && (
            <Button
              variant="outline"
              size="sm"
              aria-label={showSettings ? "Close settings" : "Settings"}
              aria-pressed={showSettings}
              onClick={() => (showSettings ? onBack() : navigate("/chat/settings"))}
              className="h-11 w-11 p-0 md:h-8 md:w-8"
            >
              <SettingsIcon className="size-4" />
            </Button>
          )}
          {(state === "unauthenticated" || state === "recoverableError") && (
            <Button size="sm" onClick={signIn} className="h-11 md:h-8">
              {state === "recoverableError" ? "Try again" : "Sign in"}
            </Button>
          )}
        </div>
      </header>

      <main className="min-h-0 flex-1">
        {shareToken ? (
          <SharedThreadSurface
            token={shareToken}
            onClose={() => {
              setShareToken(null);
              if (window.location.hash.startsWith("#share=")) {
                window.history.replaceState(null, "", window.location.pathname + window.location.search);
              }
            }}
          />
        ) : isReady && tcw ? (
          <>
            {/* ChatWorkspace stays mounted while the settings route is active —
                visibility toggle (not a <Routes> swap) preserves the assistant
                runtime, the active thread, and composer state across nav. */}
            <div className={showSettings ? "hidden" : "contents"}>
              <ChatWorkspace
                key={importRefreshKey}
                tcw={tcw}
                sessionStore={sessionStoreRef.current}
                modelRef={modelRef}
                offeredModelIdsRef={offeredModelIdsRef}
                memoryRef={memoryRef}
                onActiveThreadModel={setSelectedModel}
                onMemoryUpdated={onMemoryUpdated}
                contextTokensFor={contextTokensFor}
                sidebarOpen={sidebarOpen}
                setSidebarOpen={setSidebarOpen}
              />
            </div>
            {showSettings && (
              <SettingsPage
                address={address}
                did={did}
                spaceId={spaceId}
                state={state}
                error={error}
                onSignOut={signOut}
                paywallEnabled={paywallEnabled}
                onBack={onBack}
                tcw={tcw}
                memoryRef={memoryRef}
                onMemoryUpdated={onMemoryUpdated}
                onImported={onImported}
                billingStatus={billingStatus}
                onManagePlan={openPricing}
                onOpenRates={openRates}
                backendUrl={BACKEND_URL}
                sessionStore={sessionStoreRef.current}
              />
            )}
          </>
        ) : (
          <BootSurface state={state} error={error} onSignIn={signIn} />
        )}
      </main>

      {paywallEnabled && billingConfig && (
        <PricingDialog
          open={pricingOpen}
          onOpenChange={setPricingOpen}
          config={billingConfig}
          status={billingStatus}
          onOpenRates={openRates}
        />
      )}

      <RatesDialog
        open={ratesOpen}
        onOpenChange={setRatesOpen}
        billing={billingRef.current}
      />


      {billingNotice && (
        <div
          role="status"
          aria-live="polite"
          aria-atomic="true"
          className="fixed bottom-[max(1rem,env(safe-area-inset-bottom))] left-1/2 z-[60] -translate-x-1/2"
        >
          <div className="flex items-center gap-2 rounded-lg border border-border bg-popover px-4 py-2.5 text-sm text-popover-foreground shadow-lg">
            <span className="size-1.5 rounded-full bg-green-500" />
            {billingNotice}
          </div>
        </div>
      )}
    </div>
  );
}

// Compact, clickable usage chip in the header. Shows the current tier and a
// thin progress bar of credit-budget consumption. Opens the pricing dialog on
// click. On hover/focus, an expanded popover surfaces exact numbers + reset
// date + a "How credits work" link to the rates table (spec §5.5). Renders
// even before status loads (shows "Plans") so the entry point is always
// present once the paywall is on.
function UsageIndicator(props: {
  status: BillingStatus | null;
  onClick: () => void;
  onOpenRates: () => void;
}) {
  const { status, onClick, onOpenRates } = props;
  const [open, setOpen] = useState(false);
  const usage = status?.usage;
  const pct =
    usage && usage.limit > 0
      ? Math.min(100, Math.round((usage.used / usage.limit) * 100))
      : 0;
  const tierLabel = status ? capitalize(status.tier) : "Plans";
  const near = pct >= 90;
  const resetsLabel = usage?.resetsAt ? formatResetsAt(usage.resetsAt) : null;
  // Compact "12K / 50K" rendered in the visible chip so touch users (who can't
  // hover) still see live usage at a glance (spec §5.5 transparency).
  const compactUsage =
    usage && usage.limit > 0
      ? `${formatCompact(usage.used)} / ${formatCompact(usage.limit)}`
      : null;

  return (
    <div
      className="relative"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocusCapture={() => setOpen(true)}
      onBlurCapture={(e) => {
        // Close only when focus leaves the whole popover subtree.
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
          setOpen(false);
        }
      }}
    >
      <button
        type="button"
        onClick={onClick}
        aria-label="View plans and usage"
        className="flex h-8 items-center gap-1.5 rounded-md border border-input bg-background px-2 text-xs text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:gap-2 sm:px-2.5"
      >
        <span className="font-medium">{tierLabel}</span>
        {compactUsage && (
          <span className="hidden tabular-nums text-muted-foreground sm:inline">{compactUsage}</span>
        )}
        {usage && usage.limit > 0 && (
          <span
            className="hidden h-1.5 w-12 overflow-hidden rounded-full bg-muted sm:inline-flex"
            aria-hidden
          >
            <span
              className={`block h-full rounded-full ${near ? "bg-destructive" : "bg-primary"}`}
              style={{ width: `${pct}%` }}
            />
          </span>
        )}
      </button>
      {open && (
        <div
          role="region"
          aria-label="Usage and plan details"
          className="absolute right-0 top-full z-30 mt-1.5 w-64 max-w-[calc(100vw-2rem)] rounded-lg border border-border bg-popover p-3 text-xs text-popover-foreground shadow-lg"
        >
          {usage && usage.limit > 0 && (
            <>
              <div className="tabular-nums text-foreground">
                {usage.used.toLocaleString()} / {formatCredits(usage.limit)}
              </div>
              {resetsLabel && (
                <div className="mt-0.5 text-muted-foreground">
                  Resets {resetsLabel}
                </div>
              )}
            </>
          )}
          <button
            type="button"
            aria-haspopup="dialog"
            onClick={() => {
              setOpen(false);
              onOpenRates();
            }}
            className={`${usage && usage.limit > 0 ? "mt-2" : ""} text-xs text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring`}
          >
            How credits work →
          </button>
        </div>
      )}
    </div>
  );
}

// Short numeric label for the always-visible chip (e.g. 12_400 → "12K").
function formatCompact(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  if (n >= 1_000_000) return `${Math.round(n / 100_000) / 10}M`.replace(/\.0M$/, "M");
  if (n >= 1_000) return `${Math.round(n / 100) / 10}K`.replace(/\.0K$/, "K");
  return n.toString();
}

function formatResetsAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  try {
    return d.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    });
  } catch {
    return d.toDateString();
  }
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
}

function ChatWorkspace(props: {
  tcw: TinyCloudWeb;
  sessionStore: SessionStore;
  modelRef: React.MutableRefObject<string>;
  offeredModelIdsRef: React.MutableRefObject<ReadonlySet<string>>;
  memoryRef: React.MutableRefObject<string | null>;
  onActiveThreadModel: (model: string) => void;
  onMemoryUpdated: (doc: string | null) => void;
  contextTokensFor: (modelId: string) => number;
  sidebarOpen: boolean;
  setSidebarOpen: React.Dispatch<React.SetStateAction<boolean>>;
}) {
  // C2: stable ref written by the per-thread Provider so the adapter knows roomId.
  const activeThreadIdRef = useRef<string | null>(null);
  // C3: stable ref read by the adapter at request time to branch agent vs plain relay.
  const agentEnabledRef = useRef(false);

  const deps = useMemo(
    () => ({
      tcw: props.tcw,
      sessionStore: props.sessionStore,
      backendUrl: BACKEND_URL,
      modelRef: props.modelRef,
      offeredModelIdsRef: props.offeredModelIdsRef,
      memoryRef: props.memoryRef,
      onActiveThreadModel: props.onActiveThreadModel,
      onMemoryUpdated: props.onMemoryUpdated,
      activeThreadIdRef,
      agentEnabledRef,
      // ── Compaction deps (§D.3) ─────────────────────────────────────
      contextTokensFor: props.contextTokensFor,
      getCheckpoint: (threadId: string) => getLatestCompaction(props.tcw, threadId),
      appendCompaction: (threadId: string, coversThroughMessageId: string, summary: string) =>
        appendCompaction(props.tcw, threadId, coversThroughMessageId, summary),
      // Plain single-shot summarization (§C.9): bypasses the runtime exchange
      // ring, so it never writes thread storage / memory nor triggers extraction
      // (§F.3). max_tokens is hard-capped by the summary budget.
      summarize: ({ model, messages }: { model: string; messages: ChatMessage[] }) => {
        // Compaction is a real billed background call with NO pending visible
        // reply, so its credits bump the SESSION METER ONLY — never a badge
        // (edge case a). Fold once via aggregateTurnCredits so in-app usage
        // tracks the ledger; a 0-token/aborted summarize contributes 0.
        let folded = false;
        return completeChat({
          backendUrl: BACKEND_URL,
          sessionStore: props.sessionStore,
          model,
          messages,
          maxTokens: COMPACTION_SUMMARY_MAX_TOKENS,
          onUsage: (usage) => {
            if (folded) return;
            folded = true;
            void getCachedRates(
              createBillingClient(BACKEND_URL, props.sessionStore),
            )
              .then((rates) => {
                const m = rates.models.find((r) => r.id === model);
                if (!m) return;
                const { backgroundCredits } = aggregateTurnCredits(0, [
                  {
                    rates: m,
                    promptTokens: usage.promptTokens,
                    completionTokens: usage.completionTokens,
                  },
                ]);
                if (backgroundCredits > 0) {
                  emitReceipt(model, backgroundCredits, model);
                }
              })
              .catch(() => {
                // receipts are UI sugar; a rates failure must never surface
              });
          },
        });
      },
    }),
    [
      props.tcw,
      props.sessionStore,
      props.modelRef,
      props.offeredModelIdsRef,
      props.memoryRef,
      props.onActiveThreadModel,
      props.onMemoryUpdated,
      props.contextTokensFor,
      // activeThreadIdRef and agentEnabledRef are stable refs — omitted intentionally.
    ],
  );

  const runtime = useChatRuntime(deps);
  const closeSidebar = useCallback(
    () => props.setSidebarOpen(false),
    [props.setSidebarOpen],
  );

  // C3: capability probe + affordance state.
  const { capability, enableError, enabling, onEnable, silentlyEnabled } = useAgentEnablement({
    backendUrl: BACKEND_URL,
    sessionStore: props.sessionStore,
    tcw: props.tcw,
    agentEnabledRef,
    activeThreadIdRef,
    appName: APP_NAME,
    openkeyHost: OPENKEY_HOST,
    tinycloudHosts: props.tcw.hosts,
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <div className="grid h-full grid-cols-1 md:grid-cols-[260px_1fr]">
        <aside className="hidden min-h-0 border-r border-border bg-muted/40 md:block">
          <ThreadList />
        </aside>
        <section className="min-h-0">
          <Thread tcw={props.tcw} />
        </section>
      </div>
      <Sheet open={props.sidebarOpen} onOpenChange={props.setSidebarOpen}>
        <SheetContent className="md:hidden bg-muted/40">
          <SheetTitle className="sr-only">Chats</SheetTitle>
          <SheetDescription className="sr-only">
            List of your saved chats
          </SheetDescription>
          <ThreadList onNavigate={closeSidebar} />
        </SheetContent>
      </Sheet>
      {/* C3: one-time "Enable agent memory & tools" affordance (hidden when unavailable). */}
      <AgentEnablementBanner
        capability={capability}
        enableError={enableError}
        enabling={enabling}
        onEnable={onEnable}
        silentlyEnabled={silentlyEnabled}
      />
    </AssistantRuntimeProvider>
  );
}

function SharedThreadSurface(props: { token: string; onClose: () => void }) {
  const [thread, setThread] = useState<ThreadDoc | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setThread(null);
    setError(null);
    loadSharedThreadFromToken(props.token)
      .then((doc) => {
        if (!cancelled) setThread(doc);
      })
      .catch((err) => {
        if (!cancelled) setError(errorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [props.token]);

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <div className="text-xs font-medium text-muted-foreground">Shared chat</div>
          <h1 className="truncate text-sm font-semibold text-foreground">
            {thread?.title ?? "TinyCloud Chat"}
          </h1>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={props.onClose}>
          Close
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4">
        <div className="mx-auto flex w-full max-w-[46rem] flex-col gap-6 py-8">
          {!thread && !error && (
            <div className="text-sm text-muted-foreground">Loading shared chat...</div>
          )}
          {error && (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          )}
          {thread?.messages.map((item, index) => (
            <SharedMessage key={sharedMessageKey(item, index)} item={item} />
          ))}
        </div>
      </div>
    </div>
  );
}

function sharedMessageKey(item: StoredMessageItem, index: number): string {
  const id = (item.message as { id?: unknown })?.id;
  return typeof id === "string" ? id : String(index);
}

function messageText(item: StoredMessageItem): string {
  const parts = (item.message?.content ?? []) as readonly unknown[];
  return parts
    .map((part) => {
      const p = part as { type?: string; text?: unknown };
      return p.type === "text" && typeof p.text === "string" ? p.text : "";
    })
    .join("");
}

function SharedMessage({ item }: { item: StoredMessageItem }) {
  const role = item.message?.role;
  const text = messageText(item);
  if (!text) return null;

  if (role === "user") {
    return (
      <div className="flex w-full justify-end">
        <div className="max-w-[80%] overflow-hidden whitespace-pre-wrap break-words rounded-3xl bg-muted px-5 py-2.5 text-sm leading-relaxed text-foreground">
          {text}
        </div>
      </div>
    );
  }

  return (
    <div className="flex w-full flex-col gap-1">
      <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
        <span className="flex size-5 items-center justify-center rounded-full bg-primary text-[10px] font-semibold text-primary-foreground">
          T
        </span>
        <span>TinyCloud Chat</span>
      </div>
      <div className="whitespace-pre-wrap break-words pl-7 text-sm leading-relaxed text-foreground">
        {text}
      </div>
    </div>
  );
}

function BootSurface(props: {
  state: AppState;
  error: string | null;
  onSignIn: () => void;
}) {
  const message =
    props.state === "booting"
      ? "Restoring your session…"
      : props.state === "connecting"
        ? "Finish the OpenKey prompt to continue."
        : props.state === "signing"
          ? "Creating your TinyCloud session…"
          : props.state === "recoverableError"
            ? (props.error ?? "Something went wrong.")
            : "Sign in to start chatting. Your conversations live in your TinyCloud space.";

  const busy = props.state === "booting" || props.state === "connecting" || props.state === "signing";

  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="flex max-w-sm flex-col items-center gap-5 text-center">
        <span className="flex size-12 items-center justify-center rounded-2xl bg-primary text-xl font-bold text-primary-foreground">
          T
        </span>
        <div className="flex flex-col gap-1.5">
          <h1 className="text-xl font-semibold tracking-tight">TinyCloud Chat</h1>
          <p className="text-sm text-muted-foreground">{message}</p>
        </div>
        {(props.state === "unauthenticated" || props.state === "recoverableError") && (
          <Button onClick={props.onSignIn} className="h-11 px-6 md:h-9 md:px-4">
            {props.state === "recoverableError" ? "Try again" : "Sign in"}
          </Button>
        )}
        {busy && (
          <span className="text-xs text-muted-foreground">Working…</span>
        )}
      </div>
    </div>
  );
}

export function stateLabel(state: AppState): string {
  const labels: Record<AppState, string> = {
    booting: "Starting",
    unauthenticated: "Signed out",
    connecting: "Connecting",
    signing: "Signing in",
    ready: "Connected",
    recoverableError: "Needs attention",
  };
  return labels[state];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unexpected error";
}
