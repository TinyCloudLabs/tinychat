import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { DEFAULT_MODEL, getSetting, readMemoryCache, setSetting } from "./lib/threadStore";
import { ThemeToggle } from "@/components/theme-toggle";
import { MemoryPanel } from "@/components/MemoryPanel";
import { Button } from "@/components/ui/button";
import { BrainIcon, ChevronDownIcon } from "lucide-react";

const OPENKEY_HOST = import.meta.env.VITE_OPENKEY_HOST || "https://openkey.so";
const APP_NAME = "TinyCloud Chat";
const BACKEND_URL =
  import.meta.env.VITE_BACKEND_URL ||
  `${globalThis.location?.protocol ?? "http:"}//localhost:3014`;
const MODEL_STORAGE_KEY = "xyz.tinycloud.tinychat:active-model";

function getInitialModel(): string {
  if (typeof window === "undefined") return DEFAULT_MODEL;
  try {
    return window.localStorage.getItem(MODEL_STORAGE_KEY) ?? DEFAULT_MODEL;
  } catch {
    return DEFAULT_MODEL;
  }
}

type AppState =
  | "booting"
  | "unauthenticated"
  | "connecting"
  | "signing"
  | "ready"
  | "recoverableError";

interface ModelOption {
  id: string;
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
  const [memoryPanelOpen, setMemoryPanelOpen] = useState(false);
  // Bumped each time the runtime/panel writes back a new memory doc — lets
  // the brain button re-render its "has memory" dot without making this
  // component re-render on every keystroke in the editor.
  const [memoryVersion, bumpMemoryVersion] = useState(0);
  const onMemoryUpdated = useCallback((_doc: string | null) => {
    bumpMemoryVersion((v) => v + 1);
  }, []);
  const hasMemory = useMemo(() => {
    void memoryVersion;
    return Boolean(memoryRef.current && memoryRef.current.trim().length > 0);
  }, [memoryVersion]);

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
        if (cancelled || !saved || saved === modelRef.current) return;
        setSelectedModel(saved);
        writeLocalModel(saved);
      } catch (err) {
        // AUTH_UNAUTHORIZED or unset — keep the localStorage/default value.
        console.warn("[App] failed to load model selection from space", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [state, tcw, setSelectedModel, writeLocalModel]);

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
        if (!list.some((m) => m.id === modelRef.current) && list.length > 0) {
          // Keep default if present, otherwise fall back to first available.
          const fallback = list.find((m) => m.id === DEFAULT_MODEL)?.id ?? list[0]!.id;
          setSelectedModel(fallback);
        }
      } catch {
        // Models endpoint optional for chatting; default model still works.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [state, setSelectedModel]);

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
    if (typeof window !== "undefined") {
      try {
        window.localStorage.removeItem(MODEL_STORAGE_KEY);
      } catch {
        // localStorage disabled — nothing to clear.
      }
    }
    modelRef.current = DEFAULT_MODEL;
    memoryRef.current = null;
    setMemoryPanelOpen(false);
    setModel(DEFAULT_MODEL);
    setTcw(null);
    setAddress(null);
    setDid(null);
    setSpaceId(null);
    setModels([]);
    setState("unauthenticated");
  }, [address, tcw]);

  const isReady = state === "ready" && tcw !== null;

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-2.5">
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-2 text-sm font-semibold tracking-tight">
            <span className="flex size-6 items-center justify-center rounded-md bg-primary text-xs font-bold text-primary-foreground">
              T
            </span>
            TinyCloud Chat
          </span>
          {isReady && (
            <div className="relative">
              <select
                value={model}
                onChange={(e) => pickModel(e.target.value)}
                className="h-8 cursor-pointer appearance-none rounded-md border border-input bg-background pl-2.5 pr-7 text-xs text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label="Model"
              >
                {models.length === 0 && <option value={model}>{model}</option>}
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.id}
                  </option>
                ))}
              </select>
              <ChevronDownIcon className="pointer-events-none absolute right-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          {isReady && tcw && (
            <MemoryPopover
              tcw={tcw}
              memoryRef={memoryRef}
              open={memoryPanelOpen}
              setOpen={setMemoryPanelOpen}
              hasMemory={hasMemory}
              onMemoryUpdated={onMemoryUpdated}
            />
          )}
          <ThemeToggle />
          <ConnectionDetails
            address={address}
            did={did}
            spaceId={spaceId}
            state={state}
            error={error}
          />
          {(state === "unauthenticated" || state === "recoverableError") && (
            <Button size="sm" onClick={signIn}>
              {state === "recoverableError" ? "Try again" : "Sign in"}
            </Button>
          )}
          {isReady && (
            <Button variant="outline" size="sm" onClick={signOut}>
              Sign out
            </Button>
          )}
        </div>
      </header>

      <main className="min-h-0 flex-1">
        {isReady && tcw ? (
          <ChatWorkspace
            tcw={tcw}
            sessionStore={sessionStoreRef.current}
            modelRef={modelRef}
            memoryRef={memoryRef}
            onActiveThreadModel={setSelectedModel}
            onMemoryUpdated={onMemoryUpdated}
          />
        ) : (
          <BootSurface state={state} error={error} onSignIn={signIn} />
        )}
      </main>
    </div>
  );
}

function MemoryPopover(props: {
  tcw: TinyCloudWeb;
  memoryRef: React.MutableRefObject<string | null>;
  open: boolean;
  setOpen: React.Dispatch<React.SetStateAction<boolean>>;
  hasMemory: boolean;
  onMemoryUpdated: (doc: string | null) => void;
}) {
  const { tcw, memoryRef, open, setOpen, hasMemory, onMemoryUpdated } = props;
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  // Live dirty flag bubbled by MemoryPanel. Read inside the document-level
  // handlers below (not from React state) so a stale closure can't let a
  // click-outside silently drop unsaved edits.
  const dirtyRef = useRef(false);
  const onDirtyChange = useCallback((dirty: boolean) => {
    dirtyRef.current = dirty;
  }, []);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      const root = containerRef.current;
      if (!root) return;
      // While the Clear-memory AlertDialog (or any modal) is open, leave
      // dismissal to the dialog itself — its overlay swallows clicks and
      // its own Escape handler closes it first.
      if (document.querySelector('[role="alertdialog"][data-state="open"]')) return;
      // Don't silently discard unsaved edits — the panel surfaces an
      // "Unsaved changes" banner; require explicit Save/Revert/Close.
      if (dirtyRef.current) return;
      if (!root.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (document.querySelector('[role="alertdialog"][data-state="open"]')) return;
      if (event.key === "Escape") {
        if (dirtyRef.current) return; // keep the panel open while edits are unsaved
        setOpen(false);
        triggerRef.current?.focus();
        return;
      }
      // Focus trap: when Tab leaves the panel, cycle back to the other end.
      // Keeps a keyboard user inside the dialog while it's open — matches the
      // ARIA dialog contract we now expose on the panel root.
      if (event.key !== "Tab") return;
      const panel = containerRef.current?.querySelector<HTMLElement>("#memory-panel");
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
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, setOpen]);

  return (
    <div className="relative" ref={containerRef}>
      <Button
        ref={triggerRef}
        variant="outline"
        size="sm"
        aria-label={hasMemory ? "Memory (active)" : "Memory"}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls="memory-panel"
        onClick={() => setOpen((o) => !o)}
        className="relative h-8 gap-1.5 px-2.5 text-xs"
      >
        <BrainIcon className="size-3.5" />
        Memory
        {hasMemory && (
          <span
            aria-hidden
            className="absolute -right-0.5 -top-0.5 size-1.5 rounded-full bg-primary"
          />
        )}
      </Button>
      {open && (
        <div className="absolute right-0 z-30 mt-1.5">
          <MemoryPanel
            tcw={tcw}
            memoryRef={memoryRef}
            onMemoryUpdated={onMemoryUpdated}
            onClose={() => setOpen(false)}
            onDirtyChange={onDirtyChange}
          />
        </div>
      )}
    </div>
  );
}

function ChatWorkspace(props: {
  tcw: TinyCloudWeb;
  sessionStore: SessionStore;
  modelRef: React.MutableRefObject<string>;
  memoryRef: React.MutableRefObject<string | null>;
  onActiveThreadModel: (model: string) => void;
  onMemoryUpdated: (doc: string | null) => void;
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

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <div className="grid h-full grid-cols-[260px_1fr]">
        <aside className="min-h-0 border-r border-border bg-muted/40">
          <ThreadList />
        </aside>
        <section className="min-h-0">
          <Thread />
        </section>
      </div>
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

function ConnectionDetails(props: {
  address: string | null;
  did: string | null;
  spaceId: string | null;
  state: AppState;
  error: string | null;
}) {
  return (
    <details className="relative">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-md border border-input bg-background px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent [&::-webkit-details-marker]:hidden">
        <span
          className={`size-1.5 rounded-full ${
            props.state === "ready"
              ? "bg-green-500"
              : props.state === "recoverableError"
                ? "bg-destructive"
                : "bg-muted-foreground"
          }`}
        />
        {stateLabel(props.state)}
      </summary>
      <div className="absolute right-0 z-20 mt-1.5 w-72 rounded-lg border border-border bg-popover p-3 text-xs text-popover-foreground shadow-lg">
        <Row label="Address" value={props.address ?? "none"} mono />
        <Row label="DID" value={props.did ?? "none"} mono />
        <Row label="Space" value={props.spaceId ?? "none"} mono />
        {props.error && (
          <p className="mt-2 text-destructive">{props.error}</p>
        )}
      </div>
    </details>
  );
}

function Row(props: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-2 py-0.5">
      <span className="text-muted-foreground">{props.label}</span>
      <span className={`max-w-[10rem] truncate text-right ${props.mono ? "font-mono" : ""}`}>
        {props.value}
      </span>
    </div>
  );
}

function stateLabel(state: AppState): string {
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
