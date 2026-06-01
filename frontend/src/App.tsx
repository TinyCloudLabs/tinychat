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
import { DEFAULT_MODEL } from "./lib/threadStore";
import "./styles.css";

const OPENKEY_HOST = import.meta.env.VITE_OPENKEY_HOST || "https://openkey.so";
const APP_NAME = "TinyChat";
const BACKEND_URL =
  import.meta.env.VITE_BACKEND_URL ||
  `${globalThis.location?.protocol ?? "http:"}//localhost:3014`;

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
  const sessionStoreRef = useRef(new SessionStore("xyz.tinycloud.tinychat:session"));
  const restoredRef = useRef(false);
  const modelRef = useRef<string>(DEFAULT_MODEL);

  const [state, setState] = useState<AppState>("booting");
  const [address, setAddress] = useState<string | null>(null);
  const [did, setDid] = useState<string | null>(null);
  const [spaceId, setSpaceId] = useState<string | null>(null);
  const [tcw, setTcw] = useState<TinyCloudWeb | null>(null);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [model, setModel] = useState<string>(DEFAULT_MODEL);
  const [error, setError] = useState<string | null>(null);

  const setSelectedModel = useCallback((next: string) => {
    modelRef.current = next;
    setModel(next);
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
    setTcw(null);
    setAddress(null);
    setDid(null);
    setSpaceId(null);
    setModels([]);
    setSelectedModel(DEFAULT_MODEL);
    setState("unauthenticated");
  }, [address, tcw, setSelectedModel]);

  const isReady = state === "ready" && tcw !== null;

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      <header className="flex items-center justify-between border-b border-border px-4 py-2.5">
        <div className="flex items-center gap-3">
          <span className="text-sm font-semibold tracking-tight">TinyChat</span>
          {isReady && (
            <select
              value={model}
              onChange={(e) => setSelectedModel(e.target.value)}
              className="rounded-md border border-input bg-background px-2 py-1 text-xs text-foreground"
              aria-label="Model"
            >
              {models.length === 0 && <option value={model}>{model}</option>}
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.id}
                </option>
              ))}
            </select>
          )}
        </div>
        <div className="flex items-center gap-2">
          <ConnectionDetails
            address={address}
            did={did}
            spaceId={spaceId}
            state={state}
            error={error}
          />
          {(state === "unauthenticated" || state === "recoverableError") && (
            <button
              onClick={signIn}
              className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground"
            >
              {state === "recoverableError" ? "Try again" : "Sign in"}
            </button>
          )}
          {isReady && (
            <button
              onClick={signOut}
              className="rounded-md border border-input px-3 py-1.5 text-xs font-medium text-foreground"
            >
              Sign out
            </button>
          )}
        </div>
      </header>

      <main className="min-h-0 flex-1">
        {isReady && tcw ? (
          <ChatWorkspace
            tcw={tcw}
            sessionStore={sessionStoreRef.current}
            modelRef={modelRef}
            onActiveThreadModel={setSelectedModel}
          />
        ) : (
          <BootSurface state={state} error={error} onSignIn={signIn} />
        )}
      </main>
    </div>
  );
}

function ChatWorkspace(props: {
  tcw: TinyCloudWeb;
  sessionStore: SessionStore;
  modelRef: React.MutableRefObject<string>;
  onActiveThreadModel: (model: string) => void;
}) {
  const deps = useMemo(
    () => ({
      tcw: props.tcw,
      sessionStore: props.sessionStore,
      backendUrl: BACKEND_URL,
      modelRef: props.modelRef,
      onActiveThreadModel: props.onActiveThreadModel,
    }),
    [props.tcw, props.sessionStore, props.modelRef, props.onActiveThreadModel],
  );

  const runtime = useChatRuntime(deps);

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <div className="grid h-full grid-cols-[260px_1fr]">
        <aside className="min-h-0 border-r border-border bg-muted/30">
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
      <div className="flex max-w-sm flex-col items-center gap-4 text-center">
        <h1 className="text-lg font-semibold">TinyChat</h1>
        <p className="text-sm text-muted-foreground">{message}</p>
        {(props.state === "unauthenticated" || props.state === "recoverableError") && (
          <button
            onClick={props.onSignIn}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground"
          >
            {props.state === "recoverableError" ? "Try again" : "Sign in"}
          </button>
        )}
        {busy && <span className="text-xs text-muted-foreground">Working…</span>}
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
      <summary className="cursor-pointer list-none rounded-md border border-input px-2 py-1.5 text-xs text-muted-foreground">
        {stateLabel(props.state)}
      </summary>
      <div className="absolute right-0 z-10 mt-1 w-72 rounded-md border border-border bg-background p-3 text-xs shadow-lg">
        <Row label="Address" value={props.address ?? "none"} mono />
        <Row label="DID" value={props.did ?? "none"} mono />
        <Row label="Space" value={props.spaceId ?? "none"} mono />
        {props.error && <p className="mt-2 text-red-600">{props.error}</p>}
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
