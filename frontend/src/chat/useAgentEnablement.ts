// Agent enablement hook — capability probe plus enable/reconnect affordance.
//
// C3: on post-sign-in mount, probes GET /api/agent/session to decide whether the
// route exists and whether a session is already active. Writes agentEnabledRef so
// the ChatModelAdapter can branch to streamAgentChat without React state reads in
// the hot path.

import { useCallback, useEffect, useState } from "react";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import type { SessionStore } from "@tinyboilerplate/client";
import {
  clearAgentSessionCache,
  ensureAgentSession,
  mintAgentSessionViaFreshSignIn,
  type AgentSessionStatus,
} from "../lib/agentDelegation";
import type { AgentDelegationErrorCode } from "../lib/agentChatApi";
import type React from "react";

export type AgentCapability = "probing" | "unavailable" | "available" | "enabled";

export interface UseAgentEnablementResult {
  /** Current capability state. "unavailable" → hide the affordance. */
  capability: AgentCapability;
  /** Non-null when the last enablement attempt threw — show to the user. */
  enableError: string | null;
  /** True while ensureAgentSession is in-flight; disable the Enable button. */
  enabling: boolean;
  /** Trigger the interactive ensureAgentSession mint + courier. */
  onEnable: () => Promise<void>;
  /** Non-null when access failed during a tool call or the status probe. */
  reconnectReason: AgentDelegationErrorCode | "delegation_stale" | null;
  /** Marks the live session unusable so the banner offers an immediate re-grant. */
  onDelegationError: (code: AgentDelegationErrorCode) => void;
  /** True briefly when the probe found an already-active session (auto-dismiss). */
  silentlyEnabled: boolean;
}

export interface UseAgentEnablementOptions {
  backendUrl: string;
  sessionStore: SessionStore;
  tcw: TinyCloudWeb;
  /** Written true when the agent path becomes active; read by the adapter. */
  agentEnabledRef: React.MutableRefObject<boolean>;
  /** Read at enable time to pass roomId to ensureAgentSession. */
  activeThreadIdRef: React.MutableRefObject<string | null>;
  /** OpenKey app name for the fresh-sign-in mint passkey prompt. */
  appName: string;
  /** OpenKey host for the fresh-sign-in mint. */
  openkeyHost: string;
  /** TinyCloud hosts for the fresh-sign-in mint (matches the app session's). */
  tinycloudHosts?: string[];
}

const CSRF_HEADER = "X-Requested-With";
const CSRF_VALUE = "XMLHttpRequest";

/**
 * Pure async probe — exported for unit tests only.
 * 200+active → "enabled", 200+other → "available", 401 → "available" (route
 * exists, token stale), other non-2xx / network error → "unavailable".
 */
export async function probeAgentCapability(
  backendUrl: string,
  token: string,
): Promise<AgentCapability> {
  return (await probeAgentSession(backendUrl, token)).capability;
}

export interface AgentSessionProbe {
  capability: AgentCapability;
  status: AgentSessionStatus | null;
}

/** Probe both feature availability and the reason an existing grant is unusable. */
export async function probeAgentSession(
  backendUrl: string,
  token: string,
): Promise<AgentSessionProbe> {
  try {
    const res = await fetch(`${backendUrl.replace(/\/$/, "")}/api/agent/session`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        [CSRF_HEADER]: CSRF_VALUE,
      },
    });
    if (!res.ok) {
      // 401 → route exists but token is stale; show the affordance so the
      // enable flow can re-authenticate. Any other non-2xx → route absent.
      return {
        capability: res.status === 401 ? "available" : "unavailable",
        status: null,
      };
    }
    const body = (await res.json()) as { status?: string };
    const status: AgentSessionStatus =
      body.status === "active" || body.status === "expired" || body.status === "stale"
        ? body.status
        : "none";
    return { capability: status === "active" ? "enabled" : "available", status };
  } catch {
    return { capability: "unavailable", status: null };
  }
}

/**
 * Capability probe, first-time enablement, and renewal for the agent path.
 *
 * On mount:
 *   GET /api/agent/session
 *   404 / network error / non-2xx → "unavailable" (route absent / env unset).
 *   200 + status "active"         → "enabled" (agent path active immediately).
 *   200 + other status            → "available" (show the Enable affordance).
 *
 * onEnable:
 *   Calls ensureAgentSession (interactive passkey mint + courier).
 *   On status "active" → writes agentEnabledRef=true, moves to "enabled".
 *   On throw → stays "available", surfaces enableError for retry.
 */
export function useAgentEnablement(opts: UseAgentEnablementOptions): UseAgentEnablementResult {
  const { backendUrl, sessionStore, tcw, agentEnabledRef, activeThreadIdRef } = opts;
  const { appName, openkeyHost, tinycloudHosts } = opts;
  const [capability, setCapability] = useState<AgentCapability>("probing");
  const [enableError, setEnableError] = useState<string | null>(null);
  const [enabling, setEnabling] = useState(false);
  const [silentlyEnabled, setSilentlyEnabled] = useState(false);
  const [reconnectReason, setReconnectReason] = useState<
    AgentDelegationErrorCode | "delegation_stale" | null
  >(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const token = sessionStore.getToken();
    if (!token) {
      setCapability("unavailable");
      return;
    }

    (async () => {
      const result = await probeAgentSession(backendUrl, token);
      if (cancelled) return;
      if (result.capability === "enabled") {
        agentEnabledRef.current = true;
        setSilentlyEnabled(true);
        timer = setTimeout(() => setSilentlyEnabled(false), 5000);
      }
      setReconnectReason(
        result.status === "expired"
          ? "delegation_expired"
          : result.status === "stale"
            ? "delegation_stale"
            : null,
      );
      setCapability(result.capability);
    })();

    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  // Re-probe when the backend or session changes (e.g. sign-out/sign-in cycle).
  // agentEnabledRef is a stable ref — omitting from deps is intentional.
  }, [backendUrl, sessionStore]);

  const onDelegationError = useCallback((code: AgentDelegationErrorCode) => {
    // ensureAgentSession's per-address cache may still say "active" after the
    // remote grant expires. Invalidate it as soon as a tool reports the truth.
    clearAgentSessionCache();
    setSilentlyEnabled(false);
    setReconnectReason(code);
    setCapability("available");
  }, []);

  const onEnable = useCallback(async () => {
    setEnableError(null);
    setEnabling(true);
    try {
      const status = await ensureAgentSession({
        tcw,
        backendUrl,
        getToken: () => sessionStore.getToken(),
        roomId: activeThreadIdRef.current ?? undefined,
        // The user clicked an explicit authorization action after a completed
        // status probe. Always re-mint: this is both correct for expiry and
        // avoids a stale "active" cache turning Reconnect into a no-op.
        force: true,
        // Mint via an isolated sign-in with the exact agent consent manifest so
        // create() issues a session-key UCAN JWT the agent accepts — not the app
        // session's wallet CACAO. See mintAgentSessionViaFreshSignIn.
        _mint: () =>
          mintAgentSessionViaFreshSignIn({ appName, openkeyHost, tinycloudHosts, roomId: activeThreadIdRef.current ?? undefined }),
      });
      if (status === "active") {
        agentEnabledRef.current = true;
        setReconnectReason(null);
        setCapability("enabled");
      }
    } catch (err) {
      console.warn("[agent] enablement failed:", err instanceof Error ? err.message : err);
      let msg: string;
      if (err instanceof DOMException && err.name === "NotAllowedError") {
        msg = `Passkey sign was cancelled — tap ${reconnectReason ? "Reconnect" : "Enable"} to try again.`;
      } else if (err instanceof TypeError) {
        msg = "Could not reach agent service. Please try again later.";
      } else {
        msg = reconnectReason
          ? "Failed to reconnect private agent access. Please try again."
          : "Failed to enable agent tools. Please try again.";
      }
      setEnableError(msg);
    } finally {
      setEnabling(false);
    }
  }, [tcw, backendUrl, sessionStore, agentEnabledRef, activeThreadIdRef, appName, openkeyHost, tinycloudHosts, reconnectReason]);

  return {
    capability,
    enableError,
    enabling,
    onEnable,
    reconnectReason,
    onDelegationError,
    silentlyEnabled,
  };
}
