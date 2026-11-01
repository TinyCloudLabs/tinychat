import { createContext, createElement, useContext, useEffect, useMemo, useSyncExternalStore } from "react";
import type React from "react";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import type { SessionStore } from "@tinyboilerplate/client";
import {
  AgentOwnerMismatchError, AgentSessionError, clearAgentSessionCache, disconnectAgentSession, ensureAgentSession,
  isActiveAgentBundle, mintAgentSessionViaFreshSignIn, mintMcpSessionViaFreshSignIn,
  type AgentSessionStatus, type AgentSessionEnvelope, type AgentSessionSnapshot,
} from "../lib/agentDelegation";
import type { AgentDelegationErrorCode } from "../lib/agentChatApi";

/** Connect failure copy. Shows the server's stable error code, never its free-text detail. */
export function connectErrorMessage(error: unknown): string {
  if (error instanceof DOMException && error.name === "NotAllowedError") return "Passkey sign was cancelled. Try connecting again.";
  if (error instanceof AgentOwnerMismatchError) return error.message;
  const code = error instanceof AgentSessionError ? error.code : null;
  if (code === "delegation_expiry_too_long") {
    return "The agent grant was rejected because it lasts longer than 30 days (delegation_expiry_too_long). Check that your device clock is correct, then try again.";
  }
  return code
    ? `Failed to connect private agent access (${code}). Please try again.`
    : "Failed to connect private agent access. Please try again.";
}

export type AgentCapability = "probing" | "unavailable" | "available" | "enabled";
export interface PrivateAgentAccess { active: boolean; revision: string | null; generation: number }
export interface AgentSessionProbe {
  capability: AgentCapability;
  status: AgentSessionStatus | null;
  revision: string | null;
  probeFailed: boolean;
}
export interface AgentAccessState extends AgentSessionProbe {
  enableError: string | null;
  enabling: boolean;
  disconnecting: boolean;
  reconnectReason: AgentDelegationErrorCode | "delegation_stale" | null;
  silentlyEnabled: boolean;
}
export function agentAccessStatusLabel(state: Pick<AgentAccessState, "capability" | "status" | "reconnectReason" | "disconnecting" | "probeFailed">): string {
  if (state.disconnecting) return "Disconnecting…";
  if (state.capability === "probing") return "Checking…";
  if (state.capability === "enabled") return "Connected";
  if (state.capability === "unavailable") return state.probeFailed ? "Agent unavailable" : "Disconnected";
  if (state.status === null && state.reconnectReason === "delegation_unverified") return "Access could not be verified";
  if (state.status === null) return "Access status unknown";
  return "Disconnected";
}
export interface UseAgentEnablementOptions {
  backendUrl: string;
  sessionStore: SessionStore;
  tcw: TinyCloudWeb;
  appName: string;
  openkeyHost: string;
  tinycloudHosts?: string[];
  _mint?: () => Promise<string | AgentSessionEnvelope>;
}

export async function probeAgentSession(backendUrl: string, token: string): Promise<AgentSessionProbe> {
  try {
    const res = await fetch(`${backendUrl.replace(/\/$/, "")}/api/agent/session`, {
      method: "GET", headers: { Authorization: `Bearer ${token}`, "X-Requested-With": "XMLHttpRequest" },
    });
    if (!res.ok) return {
      capability: res.status === 401 ? "available" : "unavailable",
      status: null,
      revision: null,
      // A missing route means the agent feature is disabled; other probe errors
      // must remain visible as backend failures.
      probeFailed: res.status !== 401 && res.status !== 404,
    };
    const body = await res.json() as AgentSessionSnapshot;
    const status = ["active", "expired", "stale", "none"].includes(body.status ?? "") ? body.status! : null;
    return {
      capability: isActiveAgentBundle(body) ? "enabled" : "available",
      status: status === "active" && !isActiveAgentBundle(body) ? "stale" : status,
      revision: typeof body.revision === "string" ? body.revision : null,
      probeFailed: false,
    };
  } catch { return { capability: "unavailable", status: null, revision: null, probeFailed: true }; }
}
export async function probeAgentCapability(backendUrl: string, token: string): Promise<AgentCapability> {
  return (await probeAgentSession(backendUrl, token)).capability;
}

const AGENT_PROBE_INTERVAL_MS = 60_000;
const AGENT_PROBE_MAX_BACKOFF_MS = 5 * 60_000;

/** One account's controller is shared by Settings and the persistent chat runtime. */
export function createAgentAccessController(opts: UseAgentEnablementOptions) {
  const agentEnabledRef = { current: false }; // Route availability, including public-only access.
  const activeThreadIdRef = { current: null as string | null };
  const privateAccessRef = { current: { active: false, revision: null, generation: 0 } as PrivateAgentAccess };
  let state: AgentAccessState = { capability: "probing", status: null, revision: null, probeFailed: false, enableError: null,
    enabling: false, disconnecting: false, reconnectReason: null, silentlyEnabled: false };
  const listeners = new Set<() => void>();
  let operation = 0;
  let probeSequence = 0;
  let disposed = false;
  let ceremony: Promise<void> | null = null;
  let stopping: Promise<void> | null = null;
  let replacementPending = false;
  let signalChange = () => {};
  let pollTimer: number | undefined;
  let listening = false;
  let consecutiveProbeFailures = 0;
  const update = (patch: Partial<AgentAccessState>) => {
    if (disposed) return;
    state = { ...state, ...patch };
    listeners.forEach((listener) => listener());
  };
  const clearPollTimer = () => {
    clearTimeout(pollTimer);
    pollTimer = undefined;
  };
  const isVisible = () => typeof document === "undefined" || document.visibilityState === "visible";
  const isOnline = () => typeof window === "undefined" || window.navigator?.onLine !== false;
  const markOffline = () => {
    probeSequence++;
    clearPollTimer();
    update({ capability: "unavailable", status: null, revision: null, probeFailed: false, reconnectReason: null });
  };
  const scheduleProbe = (probeFailed?: boolean) => {
    clearPollTimer();
    if (!listening || !isVisible() || !isOnline()) return;
    if (probeFailed !== undefined) consecutiveProbeFailures = probeFailed ? consecutiveProbeFailures + 1 : 0;
    const delay = consecutiveProbeFailures > 0
      ? Math.min(AGENT_PROBE_INTERVAL_MS * 2 ** consecutiveProbeFailures, AGENT_PROBE_MAX_BACKOFF_MS)
      : AGENT_PROBE_INTERVAL_MS;
    pollTimer = window.setTimeout(() => {
      pollTimer = undefined;
      if (isVisible() && isOnline()) void refresh();
    }, delay);
  };
  const access = (active: boolean, revision: string | null) => {
    const old = privateAccessRef.current;
    if (old.active !== active || old.revision !== revision) {
      privateAccessRef.current = { active, revision, generation: old.generation + 1 };
    }
  };
  const apply = (result: AgentSessionProbe) => {
    access(result.capability === "enabled", result.revision);
    agentEnabledRef.current = result.capability === "enabled" || result.capability === "available";
    update({ ...result, reconnectReason: result.status === "expired" ? "delegation_expired"
      : result.status === "stale" ? "delegation_stale" : null });
  };
  const refresh = async () => {
    if (replacementPending || stopping) { scheduleProbe(); return; }
    if (!isOnline()) { markOffline(); return; }
    const currentOperation = operation;
    const sequence = ++probeSequence;
    const token = opts.sessionStore.getToken();
    const result = token ? await probeAgentSession(opts.backendUrl, token)
      : { capability: "unavailable" as const, status: null, revision: null, probeFailed: false };
    if (!disposed && currentOperation === operation && sequence === probeSequence) {
      apply(result);
      scheduleProbe(result.probeFailed);
    }
  };
  const invalidate = () => {
    operation++;
    probeSequence++;
    clearAgentSessionCache();
    access(false, null);
  };
  const onEnable = (): Promise<void> => {
    if (ceremony) return ceremony;
    if (stopping || disposed) return stopping ?? Promise.resolve();
    const currentOperation = ++operation;
    const isCurrent = () => !disposed && currentOperation === operation;
    update({ enabling: true, enableError: null });
    ceremony = (async () => {
      try {
        await ensureAgentSession({
          tcw: opts.tcw, backendUrl: opts.backendUrl, getToken: () => opts.sessionStore.getToken(),
          roomId: activeThreadIdRef.current ?? undefined, force: true, isCurrent,
          beforeReplace: () => {
            replacementPending = true;
            probeSequence++;
            access(false, null);
            update({ capability: "available", status: null, revision: null, probeFailed: false });
            signalChange();
          },
          _mint: opts._mint ?? ((_tcw, snapshot) => snapshot?.mcp?.serviceDid
            ? mintMcpSessionViaFreshSignIn({ appName: opts.appName, openkeyHost: opts.openkeyHost, tinycloudHosts: opts.tinycloudHosts,
              sessionAddress: opts.tcw.address(), serviceDid: snapshot.mcp.serviceDid })
            : mintAgentSessionViaFreshSignIn({ appName: opts.appName,
              openkeyHost: opts.openkeyHost, tinycloudHosts: opts.tinycloudHosts, sessionAddress: opts.tcw.address(),
              roomId: activeThreadIdRef.current ?? undefined })),
        });
        replacementPending = false;
        if (isCurrent()) { signalChange(); await refresh(); }
      } catch (error) {
        replacementPending = false;
        if (isCurrent()) {
          signalChange();
          // Cancellation/mint failure leaves the old server bundle untouched.
          await refresh();
          if (isCurrent()) update({ enableError: connectErrorMessage(error) });
        }
      } finally { ceremony = null; update({ enabling: false }); }
    })();
    return ceremony;
  };
  const onDisconnect = (): Promise<void> => {
    if (stopping) return stopping;
    invalidate(); // Synchronous: neither old browser results nor old ceremonies can win.
    const currentOperation = operation;
    update({ capability: agentEnabledRef.current ? "available" : "unavailable", status: null,
      revision: null, probeFailed: false, disconnecting: true, enableError: null, reconnectReason: null });
    signalChange();
    stopping = (async () => {
      try {
        const token = opts.sessionStore.getToken();
        if (!token) throw new Error("Disconnection was not confirmed. Sign in and retry.");
        const body = await disconnectAgentSession(opts.backendUrl, token);
        if (!disposed && operation === currentOperation) {
          apply({ capability: "available", status: "none", revision: body.revision!, probeFailed: false });
        }
      } catch {
        if (operation === currentOperation) update({ status: null, enableError: "Disconnection was not confirmed. Please retry." });
      } finally {
        stopping = null;
        update({ disconnecting: false });
        signalChange();
        scheduleProbe();
      }
    })();
    return stopping;
  };
  const onDelegationError = (code: AgentDelegationErrorCode) => {
    // The backend reports missing access on every public-only turn. When this
    // browser already knows access is off (never connected or disconnected),
    // keep the Connect copy rather than announcing a reconnect.
    const knownOff = state.capability === "available" && state.status === "none";
    if (knownOff && (code === "delegation_required" || code === "delegation_unverified")) return;
    invalidate();
    update({
      capability: "available",
      // A failed check is unknown, not stale: Settings shows "could not be verified".
      status: code === "delegation_expired" ? "expired" : code === "delegation_unverified" ? null : "stale",
      probeFailed: false,
      reconnectReason: code,
    });
    scheduleProbe();
  };
  return {
    agentEnabledRef, activeThreadIdRef, privateAccessRef, refresh, onEnable, onDisconnect, onDelegationError,
    getSnapshot: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    /** Notification carries no grants or state; receiving tabs always ask the server. */
    listen: () => {
      disposed = false;
      if (typeof window === "undefined") return () => {};
      listening = true;
      const key = `tinychat-agent-access:${opts.backendUrl.replace(/\/$/, "")}:${opts.tcw.address()?.toLowerCase()}`;
      const channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(key);
      signalChange = () => {
        channel?.postMessage("changed");
        if (!channel) window.localStorage.setItem(key, `${Date.now()}:${Math.random()}`);
      };
      const changed = () => { invalidate(); update({ status: null, capability: "available", probeFailed: false }); void refresh(); };
      const storage = (event: StorageEvent) => { if (event.key === key) changed(); };
      const focus = () => { void refresh(); };
      const online = () => { void refresh(); };
      const offline = () => { markOffline(); };
      const visible = () => {
        if (document.visibilityState === "visible") void refresh();
        else clearPollTimer();
      };
      if (channel) channel.onmessage = changed;
      window.addEventListener("storage", storage);
      window.addEventListener("focus", focus);
      window.addEventListener("online", online);
      window.addEventListener("offline", offline);
      document.addEventListener("visibilitychange", visible);
      if (!isOnline()) markOffline();
      return () => {
        listening = false;
        clearPollTimer();
        signalChange = () => {};
        channel?.close();
        window.removeEventListener("storage", storage);
        window.removeEventListener("focus", focus);
        window.removeEventListener("online", online);
        window.removeEventListener("offline", offline);
        document.removeEventListener("visibilitychange", visible);
      };
    },
    dispose: () => { listening = false; clearPollTimer(); invalidate(); disposed = true; agentEnabledRef.current = false; listeners.clear(); },
  };
}
export type AgentAccessController = ReturnType<typeof createAgentAccessController>;
export type UseAgentEnablementResult = AgentAccessState & Pick<AgentAccessController, "onEnable" | "onDisconnect" | "onDelegationError">;
const AgentAccessContext = createContext<AgentAccessController | null>(null);
export function AgentAccessProvider(props: UseAgentEnablementOptions & { children: React.ReactNode }) {
  const account = props.tcw.address()?.toLowerCase();
  const controller = useMemo(() => createAgentAccessController(props), [props.tcw, props.backendUrl, props.sessionStore, account]);
  useEffect(() => {
    const unlisten = controller.listen();
    void controller.refresh();
    return () => { unlisten(); controller.dispose(); };
  }, [controller]);
  return createElement(AgentAccessContext.Provider, { value: controller }, props.children);
}
export function useAgentAccess() {
  const controller = useContext(AgentAccessContext);
  if (!controller) throw new Error("AgentAccessProvider is required.");
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  return { ...controller, ...state };
}
