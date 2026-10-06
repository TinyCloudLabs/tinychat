import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useLocation, useNavigate } from "react-router-dom";
import OpenKey from "@openkey/sdk";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import {
  SessionStore,
  clearPersistedSession,
  connectWallet,
  createAndSignIn,
  createTinyCloudWeb,
  createApiClient,
  loadAppManifest,
  requestNonce,
  restoreTinyCloudWebSession,
  verifySession,
} from "@tinyboilerplate/client";
import {
  OFFERED_CHAT_MODELS,
  offeredChatModelContextTokens,
} from "@tinyboilerplate/core";
import { withEncryptionDecryptGrant } from "./lib/connectors/encryptionGrant";
import { uploadRunner } from "./lib/audioUpload";
import { openkeyPasskeysSupported } from "./lib/openkeyPasskeys";
import { useVisualViewportFit } from "./lib/useVisualViewport";
import { ChatWorkspace } from "./chat/ChatWorkspace";
import { ModelPicker, type ModelOption } from "./chat/ModelPicker";
import { UsageIndicator } from "./chat/UsageIndicator";
import { AgentAccessProvider } from "./chat/useAgentEnablement";
import { PricingDialog } from "./chat/PricingDialog";
import { RatesDialog } from "./chat/RatesDialog";
import {
  readMemoryCache,
  useLocalThreadStorage,
} from "./lib/threadStore";
import { resolveLocalValidation, prepareLocalSignIn } from "./lib/localValidation";
import { DEFAULT_CONTEXT_TOKENS } from "./chat/compaction";
import { loadSharedThreadFromToken, readShareTokenFromLocation } from "./lib/tinychatShareLinks";
import { historyPrefetch } from "./lib/historyPrefetch";
import {
  createBillingClient,
  type BillingClient,
  type BillingConfig,
  type BillingStatus,
} from "./lib/billingApi";
import {
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
import { Button } from "@/components/ui/button";
import { SettingsPage } from "./chat/SettingsPage";
import { ConnectorsPage } from "./chat/ConnectorsPage";
import { CaptureSurface } from "./capture/CaptureSurface";
import { AppShell } from "./shell/AppShell";
import {
  PATHS,
  homePath,
  legacyRedirectFor,
  redirectsWhenSignedOut,
  screenFor,
} from "./shell/routes";
import { PlatformContext } from "./lib/platform";
import { useSizeClass } from "./lib/sizeClass";
// W5 — the cohort meetings view. It renders NOTHING unless the backend's read
// API answers for this address (dark flag / non-cohort = 404 = invisible), and
// it needs neither the vault nor a connector key: a session is the whole
// requirement, which is what makes the meetings readable on a device that has
// never opened the app.
import { MeetingsSection } from "./chat/MeetingsSection";
// …and W6's headless counterpart: the same meetings copied into the user's OWN
// space whenever a session with an unlocked vault happens to be open. Separate
// from the view on purpose — the view must keep working with no vault at all.
import { BackendReconciler } from "./chat/BackendReconciler";
import {
  BackgroundDrainer,
  badgePendingCount,
  clearBackgroundDrainRecord,
  readBackgroundDrainRecord,
  subscribeBackgroundDrainRecord,
} from "./chat/useBackgroundDrain";
import { TranscriberLibrarySyncProvider } from "./chat/useTranscriberLibrarySync";
import { QuickVoiceNote } from "./chat/QuickVoiceNote";
import { OfflineVoiceNotes } from "./chat/OfflineVoiceNotes";
import { PendingVoiceNotesSaver } from "./chat/PendingVoiceNotesSaver";
import { nativeVoiceNotesAvailable } from "./lib/voiceNotes/nativeVoiceNotes";
import { GmeetSessionSync } from "./chat/useGmeetSessionSync";
import type {
  ModelSelectionController,
  SelectionView,
} from "./chat/modelSelection";
import { clearAgentSessionCache } from "./lib/agentDelegation";
import { signOutOpenKeySession } from "./lib/openkeySignOut";
import { isAuthSettledSignedOut } from "./lib/authRouting";
import { browserIsOffline, restorePersistedSession } from "./lib/sessionRestore";
import { onAgentPaywallError, onAgentModelSelectionError } from "./lib/agentChatApi";
import type { ThreadDoc, StoredMessageItem } from "./lib/threadStore";
import { useLocalCanvasStorage } from "./lib/conversationCanvasStore";
import type { AppState } from "./lib/appState";
import { BootSurface } from "./shell/BootSurface";

// AppState and stateLabel live in lib/appState; re-exported for imports from App.
export { stateLabel, type AppState } from "./lib/appState";

const OPENKEY_HOST = import.meta.env.VITE_OPENKEY_HOST || "https://openkey.so";
const LOCAL_VALIDATION = resolveLocalValidation(import.meta.env, globalThis.location?.hostname);
const APP_NAME = "TinyCloud Chat";
const BACKEND_URL =
  import.meta.env.VITE_BACKEND_URL ||
  `${globalThis.location?.protocol ?? "http:"}//localhost:3014`;
const TINYCLOUD_HOSTS = import.meta.env.VITE_TINYCLOUD_HOST
  ? [import.meta.env.VITE_TINYCLOUD_HOST]
  : undefined;

export function App() {
  // Track the visible viewport so the shell shrinks above the soft keyboard
  // instead of letting it cover the composer (iOS Safari `100dvh` does not).
  useVisualViewportFit();
  const initialShareToken = useMemo(() => readShareTokenFromLocation(), []);
  const sessionStoreRef = useRef(new SessionStore("xyz.tinycloud.tinychat:session"));
  const openkeyRef = useRef<OpenKey | null>(null);
  const signOutInFlightRef = useRef(false);
  const restoredRef = useRef(false);
  const restoreInFlightRef = useRef(false);
  const selectionControllerRef = useRef<ModelSelectionController | null>(null);
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
  const [models, setModels] = useState<ModelOption[]>(() =>
    OFFERED_CHAT_MODELS.map(({ id, contextTokens }) => ({ id, contextLength: contextTokens })),
  );
  const [selectionView, setSelectionView] = useState<SelectionView>({
    threadId: null,
    phase: "choosing",
    model: null,
    revision: 0,
    saving: false,
    saveFailed: false,
    canSend: false,
    canPick: false,
  });
  const [error, setError] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  // The chat screen's voice note bar: opened to record (the header button) or to
  // show a recording that is already running (one started on the offline screen).
  const [voiceNoteOpen, setVoiceNoteOpen] = useState<false | "record" | "show">(false);

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
  const billingTierName = billingConfig?.tiers.find(
    (tier) => tier.id === billingStatus?.tier,
  )?.name ?? (billingStatus
    ? billingStatus.tier.charAt(0).toUpperCase() + billingStatus.tier.slice(1)
    : null);
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
  // surfacing imported rows. The model picker, the memory popover and the auth
  // session survive the bump because they live above ChatWorkspace; the Chats
  // sheet, inside it, comes back closed.
  const [importRefreshKey, setImportRefreshKey] = useState(0);
  const onImported = useCallback(() => {
    setImportRefreshKey((k) => k + 1);
  }, []);
  const onMemoryUpdated = useCallback((_doc: string | null) => {}, []);

  const pickModel = useCallback((next: string) => {
    selectionControllerRef.current?.pick(next);
  }, []);

  // Context window (tokens) for a model id, read from the live offered catalog
  // (§D.4). Stable callback over a ref so it can be threaded into the runtime
  // deps without re-memoizing on every model-list change. Falls back to
  // DEFAULT_CONTEXT_TOKENS when the model carries no contextLength.
  const contextTokensFor = useCallback((modelId: string): number => {
    return offeredChatModelContextTokens(modelId) ?? DEFAULT_CONTEXT_TOKENS;
  }, []);

  const remediateUnavailableModel = useCallback(() => {
    setBillingNotice("That model is not available.");
  }, []);

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

  // Dev-only probe seam. The browser-e2e lane (test/connectors/browser-lane.ts)
  // asserts against REAL space storage — SQL rows, KV bodies, secrets — through
  // this handle, because a UI-only assertion cannot tell "synced" from "looks
  // synced". `import.meta.env.DEV` is statically false in a production build, so
  // the whole effect is dropped from the shipped bundle. Cleared on sign-out
  // (tcw flips to null) so a signed-out page never hands out a live session.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const w = window as unknown as { __tcw?: TinyCloudWeb | null };
    w.__tcw = tcw;
    return () => {
      w.__tcw = null;
    };
  }, [tcw]);

  // Restore an existing session on boot (both Bearer token AND tcw for KV).
  //
  // A callable rather than effect-only: the `offline` state's "Try again" and
  // the browser's `online` event re-run exactly this (TC-514). What a failure
  // MEANS lives in lib/sessionRestore: only a verdict about the session itself
  // (expired / corrupt / missing …) clears it and signs out. Failing to REACH
  // the manifest or a host keeps both the Bearer session and the persisted
  // TinyCloud session and lands in `offline` — launching on a phone with no
  // signal used to sign the user out here.
  const restoreSession = useCallback(async () => {
    if (restoreInFlightRef.current) return;
    restoreInFlightRef.current = true;
    setError(null);
    setState("booting");
    try {
      const restored = await restorePersistedSession(sessionStoreRef.current, {
        isOffline: browserIsOffline,
        loadManifest: async () => {
          // The manifest must ride along here, not just on the fresh sign-in
          // path: TinyCloudWeb stores it from constructor config only, and a
          // manifest-less instance cannot escalate permissions (secrets.put
          // throws "requestPermissions requires a stored manifest") after a
          // page reload. Vite can become ready before the backend during local
          // startup, so retry that bounded race instead of publishing a broken
          // manifest-less client as ready. Offline, the backoff would only hold
          // the user on a spinner for ~15s before saying so: one attempt.
          const manifest = await fetchConfigWithRetry(
            () => loadAppManifest(`${BACKEND_URL}/api/manifest`),
            { maxAttempts: browserIsOffline() ? 1 : 4 },
          );
          if (!manifest)
            throw new Error("Could not load the TinyCloud app manifest");
          return manifest;
        },
        restore: (storedAddress, manifest) =>
          restoreTinyCloudWebSession(storedAddress, {
            autoCreateSpace: false,
            tinycloudHosts: TINYCLOUD_HOSTS,
            manifest,
          }),
      });
      switch (restored.kind) {
        case "restored":
          setTcw(LOCAL_VALIDATION ? useLocalCanvasStorage(useLocalThreadStorage(restored.tcw)) : restored.tcw);
          setAddress(restored.address);
          setDid(restored.tcw.did ?? `did:pkh:eip155:1:${restored.address}`);
          setSpaceId(restored.tcw.spaceId ?? null);
          setState("ready");
          return;
        case "unavailable":
          setError(restored.message);
          setState("offline");
          return;
        case "signedOut":
          setState("unauthenticated");
          return;
        case "failed":
          setError(restored.message);
          setState("recoverableError");
          return;
      }
    } finally {
      restoreInFlightRef.current = false;
    }
  }, []);

  useEffect(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;
    void restoreSession();
  }, [restoreSession]);

  // "Exo will reconnect when you're back online" is a promise — keep it. Only
  // while a held session is waiting; event-driven, nothing polls.
  useEffect(() => {
    if (state !== "offline") return;
    const onOnline = () => void restoreSession();
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, [state, restoreSession]);

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
        const enrichment = new Map((result.models ?? []).map((entry) => [entry.id, entry]));
        setModels(OFFERED_CHAT_MODELS.map(({ id, contextTokens }) => ({
          id,
          contextLength: contextTokens,
          ...enrichment.get(id),
        })));
      } catch {
        // Models endpoint optional for chatting; default model still works.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [state]);

  const signIn = useCallback(async () => {
    setError(null);
    try {
      setState("connecting");
      const { address: connectedAddress, openkey, web3Provider } = await connectWallet({
        appName: APP_NAME,
        host: OPENKEY_HOST,
        passkeysSupported: openkeyPasskeysSupported(),
      });
      openkeyRef.current = openkey;
      setAddress(connectedAddress);

      const [nonce, manifest] = await Promise.all([
        requestNonce(BACKEND_URL, connectedAddress),
        loadAppManifest(`${BACKEND_URL}/api/manifest`),
      ]);

      setState("signing");
      // setupSpaceSession + ensureSpaceExists happen inside the SDK when
      // autoCreateSpace is true; the manifest grants tinycloud.kv on the space.
      //
      // withEncryptionDecryptGrant is a WORKAROUND that hardcodes an SDK-internal
      // URN format — see docs/connectors-spec.md §7 "KNOWN BLOCKER" and the header
      // of lib/connectors/encryptionGrant.ts. Secrets reads are refused without
      // it, and the grant cannot be declared in the static manifest because its
      // network id embeds this user's DID. Capabilities are minted from the
      // manifest passed here, so sign-in is the only moment it can be added.
      // Delete this call when the SDK carries the capability itself.
      const signInConfig = {
        address: connectedAddress,
        nonce,
        autoCreateSpace: !LOCAL_VALIDATION,
        tinycloudHosts: TINYCLOUD_HOSTS,
        manifest: withEncryptionDecryptGrant(manifest, connectedAddress),
      };
      const { tcw: signedTcw, session } = LOCAL_VALIDATION
        ? await (async () => {
            const localTcw = createTinyCloudWeb(web3Provider, { ...signInConfig, siweConfig: { nonce } });
            await prepareLocalSignIn(localTcw);
            await localTcw.clearPersistedSession(connectedAddress);
            return { tcw: localTcw, session: await localTcw.signIn({ nonce }) };
          })()
        : await createAndSignIn(web3Provider, signInConfig);

      // Exchange the SIWE message for a backend Bearer token (for /api/chat).
      const verified = await verifySession(BACKEND_URL, session.siwe, session.signature);
      sessionStoreRef.current.setSession(verified.token, verified.expiresIn, connectedAddress);

      setTcw(LOCAL_VALIDATION ? useLocalCanvasStorage(useLocalThreadStorage(signedTcw)) : signedTcw);
      setDid(signedTcw.did ?? null);
      setSpaceId(signedTcw.spaceId ?? null);
      setState("ready");
    } catch (caught) {
      setError(errorMessage(caught));
      setState("recoverableError");
    }
  }, []);

  const signOut = useCallback(async () => {
    if (signOutInFlightRef.current) return;
    signOutInFlightRef.current = true;
    setSigningOut(true);
    setError(null);
    try {
      const openKeyOutcome = await signOutOpenKeySession(
        openkeyRef.current,
        () => new OpenKey({ appName: APP_NAME, host: OPENKEY_HOST, passkeysSupported: openkeyPasskeysSupported() }),
      );
      // OpenKey clears this client's local auth before showing its widget, even
      // when the user cancels. Never retain that spent client for another flow.
      openkeyRef.current = null;

      let openKeyWarning: string | null = null;
      if (openKeyOutcome.status === "cancelled") {
        openKeyWarning =
          "OpenKey stayed signed in on this device. TinyChat is signed out locally. " +
          "Sign out at openkey.so before choosing another account.";
      } else if (openKeyOutcome.status === "unverified") {
        const detail = openKeyOutcome.reason ? ` (${openKeyOutcome.reason})` : "";
        openKeyWarning =
          `OpenKey sign-out could not be verified${detail}. TinyChat is signed out locally. ` +
          "Sign out at openkey.so before choosing another account.";
      }

      if (tcw) {
        try {
          await tcw.signOut?.();
        } catch (caught) {
          console.warn("[App] TinyCloud sign-out cleanup failed", caught);
        }
      }
      // TinyCloudWeb.signOut is local cleanup. Remove the persisted session
      // directly as well so a client cleanup failure cannot restore this user.
      if (address) clearPersistedSession(address);
      sessionStoreRef.current.clear();
      // Drop the in-memory history prefetch cache and stop its queue — it holds
      // the signed-out account's message docs.
      historyPrefetch.clear();
      // Clear the agent session cache so the next sign-in re-probes.
      clearAgentSessionCache();
      // Drop the background-drain counts: they belong to the account that is
      // leaving, and the next user must never inherit them. ONLY the record —
      // this page load's attempt/dark latches are about the page, not the user.
      clearBackgroundDrainRecord();
      // Stop this tab's audio upload work: it runs with the leaving account's
      // session and space. Its stored job stays for that account's next visit.
      uploadRunner.reset();
      selectionControllerRef.current = null;
      memoryRef.current = null;
      setSelectionView((view) => ({ ...view, threadId: null, model: null, canSend: false, canPick: false }));
      setTcw(null);
      setAddress(null);
      setDid(null);
      setSpaceId(null);
      setModels(OFFERED_CHAT_MODELS.map(({ id, contextTokens }) => ({ id, contextLength: contextTokens })));
      setBillingStatus(null);
      setPricingOpen(false);
      setError(openKeyWarning);
      setState(openKeyWarning ? "recoverableError" : "unauthenticated");
    } finally {
      signOutInFlightRef.current = false;
      setSigningOut(false);
    }
  }, [address, tcw]);

  const isReady = state === "ready" && tcw !== null;
  // The offline state still HOLDS a session, so its "Try again" re-runs the
  // restore. Only a settled signed-out state (no restorable session) starts the
  // full OpenKey sign-in.
  const authAction = state === "offline" ? restoreSession : signIn;
  // Authentication has answered, and the answer is "not signed in" — the
  // only condition under which a private surface may be redirected away.
  const authSettledSignedOut = isAuthSettledSignedOut(state);

  const navigate = useNavigate();
  const location = useLocation();
  const platform = useContext(PlatformContext);
  const { size } = useSizeClass();
  // Which screen the address shows (shell/routes.ts). The App stays mounted at
  // /chat/*: the shell toggles surfaces, so the chat runtime, drafts and
  // streams survive every move between them.
  const screen = useMemo(() => screenFor(location.pathname), [location.pathname]);
  const showSettings = !LOCAL_VALIDATION && screen.id === "settings";
  // Retired addresses (/chat/meetings, /chat/connectors/library) still resolve:
  // they are replaced with their new home below.
  const legacy = legacyRedirectFor(location.pathname);

  // TC-522: the one-tap voice note, inside the Exo mobile app only, and only on
  // Chat: the Voice notes card on Capture has its own Record and picks a
  // running recording up, so only one view of the recorder is ever mounted.
  // Leaving Chat, or signing out, closes it.
  const voiceNotesInApp = useMemo(() => nativeVoiceNotesAvailable(), []);
  const quickVoiceNoteAvailable =
    voiceNotesInApp && isReady && !LOCAL_VALIDATION && screen.destination === "chat" && !shareToken;
  useEffect(() => {
    if (!quickVoiceNoteAvailable) setVoiceNoteOpen(false);
  }, [quickVoiceNoteAvailable]);

  // TC-515: with the session held but out of reach (`offline`), the app can
  // still record a voice note; it stays on the phone until the session is back.
  // Not signed out: there is no account to save to then. "Try again" (`booting`)
  // keeps the recorder on screen, so a running recording stays visible.
  const [offlineCapture, setOfflineCapture] = useState(false);
  useEffect(() => {
    if (state === "offline") setOfflineCapture(true);
    else if (state !== "booting") setOfflineCapture(false);
  }, [state]);
  const offlineRecorder = voiceNotesInApp && !LOCAL_VALIDATION && offlineCapture;
  // A recording started offline keeps running through the restore: once the
  // session is back, the chat screen's bar shows it (picked up, never restarted).
  const offlineRecordingRef = useRef(false);
  useEffect(() => {
    if (state !== "ready" || !offlineRecordingRef.current) return;
    offlineRecordingRef.current = false;
    if (quickVoiceNoteAvailable) setVoiceNoteOpen("show");
  }, [state, quickVoiceNoteAvailable]);

  // The pending-count badge follows the drain record's store directly — no
  // polling, no second count, no state of its own. Whichever path settles the
  // queue next (the headless drainer or a Connectors sync) publishes into the
  // same store, so the count clears without a reload. The record is null while
  // signed out (cleared in `signOut`) and the helper is silent on dark, so
  // this is a no-op for every user on today's default deployment.
  const drainRecord = useSyncExternalStore(
    subscribeBackgroundDrainRecord,
    readBackgroundDrainRecord,
    readBackgroundDrainRecord,
  );
  // Hidden on the connectors route: the detailed queue state is visible there.
  const pendingMeetings = screen.destination === "connectors" ? 0 : badgePendingCount(drainRecord);

  // Belt-and-suspenders guard: if the user lands on (or is on) Settings or
  // Connectors while signed out (post-signOut flip, deep link, etc.), send them
  // home. These pages only render inside the isReady branch below, so this is
  // the sole place the URL gets normalized. Capture never redirects: the
  // sign-in surface renders in place (shell/routes.ts).
  //
  // Keyed on the SETTLED signed-out states, not on `!isReady`: a cold reload of
  // a private surface starts in `booting` and stays there until the persisted
  // session finishes restoring, and throwing the pathname away in that window
  // breaks the share/bookmark/reload contract these routes exist for. While
  // authentication is still deciding the address is held and BootSurface shows.
  useEffect(() => {
    if (authSettledSignedOut && redirectsWhenSignedOut(screen)) {
      navigate(homePath(platform), { replace: true });
    }
  }, [authSettledSignedOut, screen, platform, navigate]);

  // Forward a retired address (LEGACY_REDIRECTS) to its canonical home.
  // `replace` keeps the dead route out of history, so Back does not bounce
  // through it. Signed out, it goes home instead: Library is only reachable ready.
  useEffect(() => {
    if (!legacy) return;
    // Same rule as the guard above: mid-restore is not an answer. Hold the
    // legacy address until authentication settles, or the cold forward lands
    // home instead of Library.
    if (!isReady && !authSettledSignedOut) return;
    navigate(isReady ? legacy.to : homePath(platform), { replace: true });
  }, [legacy, isReady, authSettledSignedOut, platform, navigate]);

  // A1 trigger (a): entering the settings page recovers a config-null session
  // (the Plan & Usage card lives there). No-op when a config is already held.
  useEffect(() => {
    if (showSettings) refetchConfigOnTrigger("settings-entry");
  }, [showSettings, refetchConfigOnTrigger]);

  // Settings' Back: history-back, so wherever the user came from restores its
  // scroll and focus naturally; home when there's no in-app history (deep link
  // or refresh on /chat/settings). react-router v7 stamps `idx` on history state.
  const onBack = useCallback(() => {
    const idx = (window.history.state as { idx?: number } | null)?.idx;
    if (typeof idx === "number" && idx > 0) {
      navigate(-1);
    } else {
      navigate(homePath(platform), { replace: true });
    }
  }, [navigate, platform]);

  // The composer's toolbar: the model chip (a sheet on phones) and, with the
  // paywall on, the usage chip. App owns both, so they survive ChatWorkspace's
  // import-refresh remount.
  const composerToolbar = isReady ? (
    <>
      <ModelPicker
        model={selectionView.model}
        models={models}
        disabled={!selectionView.canPick}
        status={selectionView.message}
        onPick={pickModel}
        presentation={size === "compact" ? "sheet" : "popover"}
      />
      {paywallEnabled && (
        <UsageIndicator
          status={billingStatus}
          tierName={billingTierName}
          onClick={openPricing}
          onOpenRates={openRates}
        />
      )}
    </>
  ) : null;

  return (
    <div
      className="flex flex-col bg-background text-foreground"
      style={{ height: "var(--tc-app-height, 100dvh)" }}
    >
      {LOCAL_VALIDATION && (
        <div role="status" className="border-b px-4 py-2 text-sm">
          Local validation: chats and memory stay in this tab and reset on reload.
          Existing account memory, settings and connector sync are disabled.
        </div>
      )}

      <div className="min-h-0 flex-1">
        {shareToken ? (
          <main className="h-full pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] pt-[env(safe-area-inset-top)]">
            <SharedThreadSurface
              token={shareToken}
              onClose={() => {
                setShareToken(null);
                if (window.location.hash.startsWith("#share=")) {
                  window.history.replaceState(null, "", window.location.pathname + window.location.search);
                }
              }}
            />
          </main>
        ) : isReady && tcw ? (
          <AgentAccessProvider tcw={tcw} sessionStore={sessionStoreRef.current} backendUrl={BACKEND_URL}
            appName={APP_NAME} openkeyHost={OPENKEY_HOST} tinycloudHosts={tcw.hosts}>
            <TranscriberLibrarySyncProvider enabled={!LOCAL_VALIDATION} tcw={tcw} backendUrl={BACKEND_URL} sessionStore={sessionStoreRef.current}>
            {/* The shell keeps ChatWorkspace mounted while another surface is
                shown — a visibility toggle (not a <Routes> swap) preserves the
                assistant runtime, the active thread, and composer state across
                navigation. */}
            <AppShell
              screen={screen}
              platform={platform}
              pendingMeetings={pendingMeetings}
              chat={
                <ChatWorkspace
                  key={importRefreshKey}
                  tcw={tcw}
                  sessionStore={sessionStoreRef.current}
                  backendUrl={BACKEND_URL}
                  selectionControllerRef={selectionControllerRef}
                  selectionView={selectionView}
                  memoryRef={memoryRef}
                  onSelectionView={setSelectionView}
                  onSelectionAuthFailure={() => {
                    sessionStoreRef.current.clear();
                    setError("Your session expired. Sign in again to continue.");
                    setState("recoverableError");
                  }}
                  onMemoryUpdated={onMemoryUpdated}
                  contextTokensFor={contextTokensFor}
                  composerToolbar={composerToolbar}
                  // The chat screen's voice note bar (phone app), under the chat header.
                  voiceNoteBar={voiceNoteOpen && quickVoiceNoteAvailable && tcw && (
                    <QuickVoiceNote
                      autoStart={voiceNoteOpen === "record"}
                      tcw={tcw}
                      backendUrl={BACKEND_URL}
                      sessionStore={sessionStoreRef.current}
                      onClose={() => setVoiceNoteOpen(false)}
                      onOpenLibrary={() => navigate(PATHS.library)}
                    />
                  )}
                  onVoiceNote={quickVoiceNoteAvailable ? () => setVoiceNoteOpen((open) => open || "record") : undefined}
                  voiceNoteOpen={voiceNoteOpen !== false}
                  settings={!LOCAL_VALIDATION}
                  billingStatus={billingStatus}
                />
              }
              capture={LOCAL_VALIDATION ? null : <CaptureSurface
                tcw={tcw}
                backendUrl={BACKEND_URL}
                sessionStore={sessionStoreRef.current}
                active={screen.destination === "capture"}
                screen={screen}
                meetingsSlot={
                  <MeetingsSection
                    backendUrl={BACKEND_URL}
                    sessionStore={sessionStoreRef.current}
                  />
                }
              />}
              connectors={LOCAL_VALIDATION ? null : <ConnectorsPage
                tcw={tcw}
                backendUrl={BACKEND_URL}
                sessionStore={sessionStoreRef.current}
              />}
              settings={LOCAL_VALIDATION ? null : <SettingsPage
                address={address}
                did={did}
                spaceId={spaceId}
                state={state}
                error={error}
                onSignOut={signOut}
                signingOut={signingOut}
                paywallEnabled={paywallEnabled}
                onBack={onBack}
                tcw={tcw}
                memoryRef={memoryRef}
                onMemoryUpdated={onMemoryUpdated}
                onImported={onImported}
                billingStatus={billingStatus}
                billingTierName={billingTierName}
                onManagePlan={openPricing}
                onOpenRates={openRates}
                backendUrl={BACKEND_URL}
                sessionStore={sessionStoreRef.current}
              />}
            />
            </TranscriberLibrarySyncProvider>
          </AgentAccessProvider>
        ) : (
          <main className="h-full pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] pt-[env(safe-area-inset-top)]">
            <BootSurface
              state={state}
              error={error}
              onAction={authAction}
              voiceNotes={
                offlineRecorder ? (
                  <OfflineVoiceNotes onRecordingChange={(recording) => { offlineRecordingRef.current = recording; }} />
                ) : null
              }
            />
          </main>
        )}
      </div>

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

      {/* The once-per-session headless webhook-queue drain (Option C's "next
          visit"). Same gate as the authenticated surfaces; renders nothing in
          every state, coordinates with Settings on a shared lane, and never
          unlocks — see useBackgroundDrain.ts. */}
      {!LOCAL_VALIDATION && state === "ready" && tcw && (
        <BackgroundDrainer
          tcw={tcw}
          sessionStore={sessionStoreRef.current}
          backendUrl={BACKEND_URL}
        />
      )}

      {/* TC-515: voice notes left on the phone (recorded offline, or a save that
          failed) are saved once the session is ready, without opening
          Capture. The Voice notes card's own single-flight retry. */}
      {voiceNotesInApp && !LOCAL_VALIDATION && state === "ready" && tcw && (
        <PendingVoiceNotesSaver
          tcw={tcw}
          backendUrl={BACKEND_URL}
          sessionStore={sessionStoreRef.current}
        />
      )}

      {/* The once-per-session Google Meet sync — a SEPARATE lane from the
          drainer above (gmeet has no webhook queue). Same ready gate; renders
          nothing, defers silently while the vault is locked, and is a no-op for
          every user while the registry row is coming-soon. */}
      {!LOCAL_VALIDATION && state === "ready" && tcw && (
        <GmeetSessionSync
          tcw={tcw}
          sessionStore={sessionStoreRef.current}
          backendUrl={BACKEND_URL}
        />
      )}

      {/* W6's browser reconcile: with an unlocked vault, copy the meetings the
          backend already holds into the user's OWN space (KV only), then stamp
          them. Renders nothing, queues on the drain's lane so the one space has
          a single writer, and is a no-op for every address outside the dark
          cohort — see BackendReconciler.tsx. */}
      {!LOCAL_VALIDATION && state === "ready" && tcw && (
        <BackendReconciler
          tcw={tcw}
          sessionStore={sessionStoreRef.current}
          backendUrl={BACKEND_URL}
        />
      )}

      {billingNotice && (
        <div
          role="status"
          aria-live="polite"
          aria-atomic="true"
          className="fixed bottom-[calc(var(--tc-bottom-chrome)+1rem)] left-1/2 z-[60] -translate-x-1/2"
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unexpected error";
}
