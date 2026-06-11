import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
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
import { useChatRuntime } from "./chat/runtime";
import { Thread } from "./chat/Thread";
import { ThreadList } from "./chat/ThreadList";
import { PricingDialog } from "./chat/PricingDialog";
import { RatesDialog } from "./chat/RatesDialog";
import { DEFAULT_MODEL, getSetting, readMemoryCache, setSetting } from "./lib/threadStore";
import { historyPrefetch } from "./lib/historyPrefetch";
import {
  createBillingClient,
  formatCredits,
  type BillingClient,
  type BillingConfig,
  type BillingStatus,
} from "./lib/billingApi";
import { onBillingEvent, onPaywallError } from "./lib/chatApi";
import { isPaywallActionable } from "./lib/paywall";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { SettingsPage } from "./chat/SettingsPage";
import { ModelVerificationIndicator } from "./chat/ModelVerificationIndicator";
import {
  ChevronDownIcon,
  LockIcon,
  PanelLeftIcon,
  SettingsIcon,
  ShieldCheckIcon,
  ShieldIcon,
} from "lucide-react";
import { isTeeCapableModel, isVerifiableModel } from "./lib/completionStore";
import { healPersistedModel, sanitizeModel } from "./lib/sanitizeModel";

const OPENKEY_HOST = import.meta.env.VITE_OPENKEY_HOST || "https://openkey.so";
const APP_NAME = "TinyCloud Chat";
const BACKEND_URL =
  import.meta.env.VITE_BACKEND_URL ||
  `${globalThis.location?.protocol ?? "http:"}//localhost:3014`;
const MODEL_STORAGE_KEY = "xyz.tinycloud.tinychat:active-model";
// Empty offered-set sentinel for the pre-/models-load sanitize path (ST1).
const EMPTY_OFFERED: ReadonlySet<string> = new Set();
const HIGH_BURN_ACK_KEY = "xyz.tinycloud.tinychat:high-burn-ack";
const HIGH_BURN_THRESHOLD = 10;

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
}

export function App() {
  const initialModel = getInitialModel();
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

  // ── Billing / paywall state ──────────────────────────────────────
  // config is fetched once on load (public, cached); status is fetched after
  // sign-in and refreshed on dialog-open + after a successful checkout. All
  // paywall UI is gated on `billingConfig?.paywallEnabled` — when the backend
  // reports the paywall off (or before config loads) nothing renders.
  const billingRef = useRef<BillingClient>(
    createBillingClient(BACKEND_URL, sessionStoreRef.current),
  );
  const [billingConfig, setBillingConfig] = useState<BillingConfig | null>(null);
  const [billingStatus, setBillingStatus] = useState<BillingStatus | null>(null);
  const [pricingOpen, setPricingOpen] = useState(false);
  const [ratesOpen, setRatesOpen] = useState(false);
  const [billingNotice, setBillingNotice] = useState<string | null>(null);
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

  // On sign-in, reconcile the picker with the cross-device default from the
  // user's space (SQL is the source of truth). localStorage already painted the
  // picker instantly; this updates it if another device changed the preference.
  useEffect(() => {
    if (state !== "ready" || !tcw) return;
    let cancelled = false;
    (async () => {
      try {
        const saved = await getSetting(tcw, "active_model");
        if (cancelled || !saved) return;
        // ST1 — validate the restored value against the offered catalog. A stale
        // non-offered id heals to DEFAULT_MODEL and the correction is persisted
        // back (SQL + localStorage) via pickModel so it does NOT recur next
        // sign-in — even when the corrected value already matches the picker.
        const offered = new Set(models.map((m) => m.id));
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
  }, [state, tcw, models, pickModel, setSelectedModel, writeLocalModel]);

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

  // Fetch the billing config once on load (public, no auth). Cached for the
  // session. The result decides whether ANY paywall UI renders.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const cfg = await billingRef.current.getConfig();
        if (!cancelled) setBillingConfig(cfg);
      } catch {
        // No config → treat the paywall as off (no UI).
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Fetch billing status after sign-in (only when the paywall is on).
  useEffect(() => {
    if (state !== "ready" || !paywallEnabled) return;
    void refreshBillingStatus();
  }, [state, paywallEnabled, refreshBillingStatus]);

  // Optimistically bump the usage chip when a receipt event fires — avoids
  // a per-message status refetch. Real reconciliation happens on dialog-open,
  // ?billing=success, and 402. Skips silently before status loads.
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
      const offered = new Set(models.map((m) => m.id));
      const corrected = sanitizeModel(modelRef.current, offered);
      if (corrected !== modelRef.current) pickModel(corrected);
      setBillingNotice("Switched to a verifiable model.");
    });
  }, [refreshBillingStatus, models, pickModel]);

  // Handle Stripe Checkout redirect-back: ?billing=success | ?billing=cancelled.
  // Success → refetch status + show a brief notice; cancelled → silent. Either
  // way, strip the param so a refresh doesn't re-trigger.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const billing = params.get("billing");
    if (billing !== "success" && billing !== "cancelled") return;
    if (billing === "success") {
      void refreshBillingStatus();
      setBillingNotice("Subscription updated. Thanks for upgrading!");
    }
    params.delete("billing");
    const query = params.toString();
    const next = window.location.pathname + (query ? `?${query}` : "") + window.location.hash;
    window.history.replaceState(null, "", next);
  }, [refreshBillingStatus]);

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
    if (typeof window !== "undefined") {
      try {
        window.localStorage.removeItem(MODEL_STORAGE_KEY);
      } catch {
        // localStorage disabled — nothing to clear.
      }
    }
    modelRef.current = DEFAULT_MODEL;
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
    <div className="flex h-dvh flex-col bg-background text-foreground pt-[env(safe-area-inset-top)]">
      <header className="flex items-center justify-between gap-1.5 border-b border-border px-3 py-2.5 sm:gap-3 sm:px-4">
        <div className="flex items-center gap-1.5 sm:gap-3">
          {isReady && (
            <Button
              variant="outline"
              size="sm"
              aria-label="Open chat list"
              onClick={() => setSidebarOpen(true)}
              className="h-8 w-8 p-0 md:hidden"
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
            <ModelPicker
              model={model}
              models={models}
              paywallEnabled={paywallEnabled}
              onPick={pickModel}
              onLockedPick={openPricing}
              onOpenRates={openRates}
            />
          )}
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
            <div className="hidden sm:block">
              <UsageIndicator
                status={billingStatus}
                onClick={openPricing}
                onOpenRates={openRates}
              />
            </div>
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
              className="h-8 w-8 p-0"
            >
              <SettingsIcon className="size-4" />
            </Button>
          )}
          {(state === "unauthenticated" || state === "recoverableError") && (
            <Button size="sm" onClick={signIn}>
              {state === "recoverableError" ? "Try again" : "Sign in"}
            </Button>
          )}
        </div>
      </header>

      <main className="min-h-0 flex-1">
        {isReady && tcw ? (
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
                memoryRef={memoryRef}
                onActiveThreadModel={setSelectedModel}
                onMemoryUpdated={onMemoryUpdated}
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
          billing={billingRef.current}
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
          className="fixed bottom-4 left-1/2 z-[60] -translate-x-1/2"
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

// Model picker. Custom dropdown in both paywall on/off — paywall-off variant
// drops the lock affordance but still surfaces the multiplier badge so users
// can see per-model burn rates (spec §5.4). On a first-time pick of a
// high-burn model (multiplier ≥ 10), surfaces a one-time inline confirm with
// the "[View rates] [OK]" affordance and persists the ack to localStorage.
function ModelPicker(props: {
  model: string;
  models: ModelOption[];
  paywallEnabled: boolean;
  onPick: (id: string) => void;
  onLockedPick: () => void;
  onOpenRates: () => void;
}) {
  const { model, models, paywallEnabled, onPick, onLockedPick, onOpenRates } = props;
  const [open, setOpen] = useState(false);
  const [focusedIndex, setFocusedIndex] = useState(-1);
  const [nudge, setNudge] = useState<{ id: string; multiplier: number } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const nudgeRef = useRef<HTMLDivElement>(null);
  const nudgeOkRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      const root = containerRef.current;
      if (root && !root.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // When the listbox opens, move focus to the currently selected option (or
  // the first) so arrow-key navigation has a starting point — WAI-ARIA listbox
  // contract (spec §5.4 model picker accessibility).
  useEffect(() => {
    if (!open || models.length === 0) return;
    const activeIdx = models.findIndex((m) => m.id === model);
    const startIdx = activeIdx >= 0 ? activeIdx : 0;
    setFocusedIndex(startIdx);
    // Focus on the next tick so the rendered option ref is populated.
    queueMicrotask(() => optionRefs.current[startIdx]?.focus());
  }, [open, models, model]);

  // Baseline = the model whose multiplier is 1 (snap-up means there can only
  // be one "1×" — usually the configured REDPILL_DEFAULT_MODEL). Fall back to
  // a generic label when the catalog hasn't loaded yet.
  const baseline = useMemo(
    () => models.find((m) => m.multiplier === 1)?.id ?? "baseline",
    [models],
  );

  const select = (m: ModelOption) => {
    if (paywallEnabled && m.allowed === false) {
      setOpen(false);
      onLockedPick();
      return;
    }
    onPick(m.id);
    setOpen(false);
    // Return focus to the trigger when the listbox closes. If a high-burn nudge
    // opens, its own auto-focus effect runs after this commit and moves focus to
    // the nudge's OK button, so it wins; otherwise focus lands back on the
    // trigger instead of falling through to <body>.
    triggerRef.current?.focus();
    if (
      typeof m.multiplier === "number" &&
      m.multiplier >= HIGH_BURN_THRESHOLD &&
      !hasHighBurnAck()
    ) {
      setNudge({ id: m.id, multiplier: m.multiplier });
    }
  };

  const ackNudge = useCallback(() => {
    setHighBurnAck();
    setNudge(null);
  }, []);

  // WAI-ARIA dialog: when the nudge opens, move focus into it and trap Tab
  // inside until it closes.
  useEffect(() => {
    if (!nudge) return;
    nudgeOkRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        ackNudge();
        return;
      }
      if (event.key !== "Tab") return;
      const panel = nudgeRef.current;
      if (!panel) return;
      const focusables = panel.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (event.shiftKey && (active === first || !panel.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
    };
  }, [nudge, ackNudge]);

  const onListKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (models.length === 0) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      const next = (focusedIndex + 1) % models.length;
      setFocusedIndex(next);
      optionRefs.current[next]?.focus();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      const next = (focusedIndex - 1 + models.length) % models.length;
      setFocusedIndex(next);
      optionRefs.current[next]?.focus();
    } else if (event.key === "Home") {
      event.preventDefault();
      setFocusedIndex(0);
      optionRefs.current[0]?.focus();
    } else if (event.key === "End") {
      event.preventDefault();
      const last = models.length - 1;
      setFocusedIndex(last);
      optionRefs.current[last]?.focus();
    } else if (event.key === "Enter" || event.key === " ") {
      const m = models[focusedIndex];
      if (m) {
        event.preventDefault();
        select(m);
      }
    }
  };

  return (
    <div className="relative" ref={containerRef}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls="model-picker-popup"
        aria-label="Model"
        className="flex h-8 items-center gap-1.5 rounded-md border border-input bg-background pl-2.5 pr-2 text-xs text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {isVerifiableModel(model) && (
          <ShieldCheckIcon
            className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400"
            aria-hidden
          />
        )}
        <span className="max-w-[7rem] truncate sm:max-w-[12rem]">{model}</span>
        <ChevronDownIcon className="size-3.5 text-muted-foreground" />
      </button>
      {open && (
        <div
          id="model-picker-popup"
          ref={listRef}
          role="listbox"
          aria-label="Model"
          onKeyDown={onListKeyDown}
          className="absolute left-0 z-30 mt-1.5 max-h-72 w-72 max-w-[calc(100vw-2rem)] overflow-y-auto rounded-lg border border-border bg-popover p-1 text-xs shadow-lg focus:outline-none"
        >
          {models.length === 0 && (
            <div className="px-2 py-1.5 text-muted-foreground">{model}</div>
          )}
          {models.map((m, i) => {
            const locked = paywallEnabled && m.allowed === false;
            const active = m.id === model;
            const badge =
              typeof m.multiplier === "number" && m.multiplier > 1
                ? `${formatMultiplier(m.multiplier)}×`
                : null;
            return (
              <button
                key={m.id}
                id={`model-option-${i}`}
                ref={(el) => {
                  optionRefs.current[i] = el;
                }}
                type="button"
                role="option"
                aria-selected={active}
                aria-disabled={locked || undefined}
                aria-label={
                  locked
                    ? `${m.id} (locked, requires ${m.requiredTier} plan)`
                    : undefined
                }
                tabIndex={focusedIndex === i ? 0 : -1}
                onClick={() => select(m)}
                onFocus={() => setFocusedIndex(i)}
                className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent focus:bg-accent focus:outline-none ${
                  active ? "bg-accent/60" : ""
                }`}
              >
                {paywallEnabled ? (
                  locked ? (
                    <LockIcon className="size-3.5 shrink-0 text-muted-foreground" />
                  ) : (
                    <span className="size-3.5 shrink-0" />
                  )
                ) : null}
                <span
                  className={`flex-1 truncate ${locked ? "text-muted-foreground" : "text-foreground"}`}
                >
                  {m.id}
                </span>
                {isVerifiableModel(m.id) ? (
                  <span
                    className="inline-flex shrink-0 text-emerald-600 dark:text-emerald-400"
                    title="Verifiable in-browser — Intel TDX (on-chain) + signed response"
                    aria-label="Verifiable in-browser"
                  >
                    <ShieldCheckIcon className="size-3.5" aria-hidden />
                  </span>
                ) : isTeeCapableModel(m.id) ? (
                  <span
                    className="inline-flex shrink-0 text-muted-foreground"
                    title="Confidential (TEE) — enclave attestable on-chain"
                    aria-label="Confidential (TEE) — enclave attestable"
                  >
                    <ShieldIcon className="size-3.5" aria-hidden />
                  </span>
                ) : null}
                {badge && (
                  <span className="shrink-0 rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold text-primary tabular-nums">
                    {badge}
                  </span>
                )}
                {locked && m.requiredTier && (
                  <span className="shrink-0 rounded-full border border-border bg-muted px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground">
                    {capitalize(m.requiredTier)}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
      {nudge &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            className="fixed inset-0 z-50 flex items-start justify-center bg-background/60 p-4 sm:items-center"
            onMouseDown={(e) => {
              // Click on the backdrop dismisses; clicks inside the dialog bubble
              // up but are stopped by the inner mousedown handler.
              if (e.target === e.currentTarget) ackNudge();
            }}
          >
            <div
              ref={nudgeRef}
              role="dialog"
              aria-modal="true"
              aria-label="High-burn model notice"
              onMouseDown={(e) => e.stopPropagation()}
              className="w-full max-w-sm rounded-lg border border-border bg-popover p-3 text-xs shadow-lg"
            >
              <p className="text-foreground">
                This model uses credits ~{formatMultiplier(nudge.multiplier)}× faster than{" "}
                <span className="font-mono">{baseline}</span>.
              </p>
              <div className="mt-2.5 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => {
                    ackNudge();
                    onOpenRates();
                  }}
                  className="rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  View rates
                </button>
                <button
                  ref={nudgeOkRef}
                  type="button"
                  onClick={ackNudge}
                  className="rounded-md bg-primary px-2.5 py-1 text-xs font-semibold text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  OK
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}

function formatMultiplier(n: number): string {
  if (!Number.isFinite(n)) return "?";
  return Number.isInteger(n) ? n.toString() : Number.parseFloat(n.toFixed(1)).toString();
}

function hasHighBurnAck(): boolean {
  if (typeof window === "undefined") return true;
  try {
    return window.localStorage.getItem(HIGH_BURN_ACK_KEY) === "1";
  } catch {
    // localStorage disabled — assume ack so we don't nag forever.
    return true;
  }
}

function setHighBurnAck(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(HIGH_BURN_ACK_KEY, "1");
  } catch {
    // localStorage full/disabled — best-effort; the nudge will just re-fire.
  }
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
}

function ChatWorkspace(props: {
  tcw: TinyCloudWeb;
  sessionStore: SessionStore;
  modelRef: React.MutableRefObject<string>;
  memoryRef: React.MutableRefObject<string | null>;
  onActiveThreadModel: (model: string) => void;
  onMemoryUpdated: (doc: string | null) => void;
  sidebarOpen: boolean;
  setSidebarOpen: React.Dispatch<React.SetStateAction<boolean>>;
}) {
  const deps = useMemo(
    () => ({
      tcw: props.tcw,
      sessionStore: props.sessionStore,
      backendUrl: BACKEND_URL,
      modelRef: props.modelRef,
      memoryRef: props.memoryRef,
      onActiveThreadModel: props.onActiveThreadModel,
      onMemoryUpdated: props.onMemoryUpdated,
    }),
    [
      props.tcw,
      props.sessionStore,
      props.modelRef,
      props.memoryRef,
      props.onActiveThreadModel,
      props.onMemoryUpdated,
    ],
  );

  const runtime = useChatRuntime(deps);
  const closeSidebar = useCallback(
    () => props.setSidebarOpen(false),
    [props.setSidebarOpen],
  );

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <div className="grid h-full grid-cols-1 md:grid-cols-[260px_1fr]">
        <aside className="hidden min-h-0 border-r border-border bg-muted/40 md:block">
          <ThreadList />
        </aside>
        <section className="min-h-0">
          <Thread />
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
    </AssistantRuntimeProvider>
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
          <Button onClick={props.onSignIn}>
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
