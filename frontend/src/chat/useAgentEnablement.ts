import { createContext, createElement, useContext, useEffect, useMemo, useSyncExternalStore } from "react";
import type React from "react";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import type { SessionStore } from "@tinyboilerplate/client";
import {
  clearAgentSessionCache, disconnectAgentSession, ensureAgentSession,
  isActiveAgentBundle, mintAgentSessionViaFreshSignIn,
  type AgentSessionStatus, type AgentSessionEnvelope, type AgentSessionSnapshot,
} from "../lib/agentDelegation";
import type { AgentDelegationErrorCode } from "../lib/agentChatApi";

export type AgentCapability = "probing" | "unavailable" | "available" | "enabled";
export interface PrivateAgentAccess { active: boolean; revision: string | null; generation: number }
export interface AgentSessionProbe {
  capability: AgentCapability;
  status: AgentSessionStatus | null;
  revision: string | null;
}
export interface AgentAccessState extends AgentSessionProbe {
  enableError: string | null;
  enabling: boolean;
  disconnecting: boolean;
  reconnectReason: AgentDelegationErrorCode | "delegation_stale" | null;
  silentlyEnabled: boolean;
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
    if (!res.ok) return { capability: res.status === 401 ? "available" : "unavailable", status: null, revision: null };
    const body = await res.json() as AgentSessionSnapshot;
    const status = ["active", "expired", "stale", "none"].includes(body.status ?? "") ? body.status! : null;
    return {
      capability: isActiveAgentBundle(body) ? "enabled" : "available",
      status: status === "active" && !isActiveAgentBundle(body) ? "stale" : status,
      revision: typeof body.revision === "string" ? body.revision : null,
    };
  } catch { return { capability: "unavailable", status: null, revision: null }; }
}
export async function probeAgentCapability(backendUrl: string, token: string): Promise<AgentCapability> {
  return (await probeAgentSession(backendUrl, token)).capability;
}

/** One account's controller is shared by Settings and the persistent chat runtime. */
export function createAgentAccessController(opts: UseAgentEnablementOptions) {
  const agentEnabledRef = { current: false }; // Route availability, including public-only access.
  const activeThreadIdRef = { current: null as string | null };
  const privateAccessRef = { current: { active: false, revision: null, generation: 0 } as PrivateAgentAccess };
  let state: AgentAccessState = { capability: "probing", status: null, revision: null, enableError: null,
    enabling: false, disconnecting: false, reconnectReason: null, silentlyEnabled: false };
  const listeners = new Set<() => void>();
  let operation = 0;
  let probeSequence = 0;
  let disposed = false;
  let ceremony: Promise<void> | null = null;
  let stopping: Promise<void> | null = null;
  let replacementPending = false;
  let signalChange = () => {};
  const update = (patch: Partial<AgentAccessState>) => {
    if (disposed) return;
    state = { ...state, ...patch };
    listeners.forEach((listener) => listener());
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
    if (replacementPending || stopping) return;
    const currentOperation = operation;
    const sequence = ++probeSequence;
    const token = opts.sessionStore.getToken();
    const result = token ? await probeAgentSession(opts.backendUrl, token)
      : { capability: "unavailable" as const, status: null, revision: null };
    if (!disposed && currentOperation === operation && sequence === probeSequence) apply(result);
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
            update({ capability: "available", status: null, revision: null });
            signalChange();
          },
          _mint: opts._mint ?? (() => mintAgentSessionViaFreshSignIn({ appName: opts.appName,
            openkeyHost: opts.openkeyHost, tinycloudHosts: opts.tinycloudHosts,
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
          if (isCurrent()) update({ enableError: error instanceof DOMException && error.name === "NotAllowedError"
            ? "Passkey sign was cancelled. Try connecting again."
            : "Failed to connect private agent access. Please try again." });
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
      revision: null, disconnecting: true, enableError: null });
    signalChange();
    stopping = (async () => {
      try {
        const token = opts.sessionStore.getToken();
        if (!token) throw new Error("Disconnection was not confirmed. Sign in and retry.");
        const body = await disconnectAgentSession(opts.backendUrl, token);
        if (!disposed && operation === currentOperation) {
          apply({ capability: "available", status: "none", revision: body.revision! });
        }
      } catch {
        if (operation === currentOperation) update({ status: null, enableError: "Disconnection was not confirmed. Please retry." });
      } finally { stopping = null; update({ disconnecting: false }); signalChange(); }
    })();
    return stopping;
  };
  const onDelegationError = (code: AgentDelegationErrorCode) => {
    invalidate();
    update({ capability: "available", status: code === "delegation_expired" ? "expired" : "stale", reconnectReason: code });
  };
  return {
    agentEnabledRef, activeThreadIdRef, privateAccessRef, refresh, onEnable, onDisconnect, onDelegationError,
    getSnapshot: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    /** Notification carries no grants or state; receiving tabs always ask the server. */
    listen: () => {
      disposed = false;
      if (typeof window === "undefined") return () => {};
      const key = `tinychat-agent-access:${opts.backendUrl.replace(/\/$/, "")}:${opts.tcw.address()?.toLowerCase()}`;
      const channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(key);
      signalChange = () => {
        channel?.postMessage("changed");
        if (!channel) window.localStorage.setItem(key, `${Date.now()}:${Math.random()}`);
      };
      const changed = () => { invalidate(); update({ status: null, capability: "available" }); void refresh(); };
      const storage = (event: StorageEvent) => { if (event.key === key) changed(); };
      const focus = () => { void refresh(); };
      const visible = () => { if (document.visibilityState === "visible") void refresh(); };
      if (channel) channel.onmessage = changed;
      window.addEventListener("storage", storage);
      window.addEventListener("focus", focus);
      document.addEventListener("visibilitychange", visible);
      return () => {
        signalChange = () => {};
        channel?.close();
        window.removeEventListener("storage", storage);
        window.removeEventListener("focus", focus);
        document.removeEventListener("visibilitychange", visible);
      };
    },
    dispose: () => { invalidate(); disposed = true; agentEnabledRef.current = false; listeners.clear(); },
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
