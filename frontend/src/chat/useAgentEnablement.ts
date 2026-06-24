// Agent enablement hook — capability probe + one-time "Enable agent memory & tools" affordance.
//
// C3: on post-sign-in mount, probes GET /api/agent/session to decide whether the
// route exists and whether a session is already active. Writes agentEnabledRef so
// the ChatModelAdapter can branch to streamAgentChat without React state reads in
// the hot path.

import { useCallback, useEffect, useState } from "react";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import type { SessionStore } from "@tinyboilerplate/client";
import { ensureAgentSession, mintAgentDelegationViaFreshSignIn } from "../lib/agentDelegation";
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
      return res.status === 401 ? "available" : "unavailable";
    }
    const body = (await res.json()) as { status?: string };
    return body.status === "active" ? "enabled" : "available";
  } catch {
    return "unavailable";
  }
}

/**
 * Capability probe + one-time enablement for the agent (tool-calling) path.
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

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const token = sessionStore.getToken();
    if (!token) {
      setCapability("unavailable");
      return;
    }

    (async () => {
      const result = await probeAgentCapability(backendUrl, token);
      if (cancelled) return;
      if (result === "enabled") {
        agentEnabledRef.current = true;
        setSilentlyEnabled(true);
        timer = setTimeout(() => setSilentlyEnabled(false), 5000);
      }
      setCapability(result);
    })();

    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  // Re-probe when the backend or session changes (e.g. sign-out/sign-in cycle).
  // agentEnabledRef is a stable ref — omitting from deps is intentional.
  }, [backendUrl, sessionStore]);

  const onEnable = useCallback(async () => {
    setEnableError(null);
    setEnabling(true);
    try {
      const status = await ensureAgentSession({
        tcw,
        backendUrl,
        getToken: () => sessionStore.getToken(),
        roomId: activeThreadIdRef.current ?? undefined,
        // Mint via a fresh, plain sign-in (no app manifest) so create() issues a
        // session-key UCAN JWT the agent accepts — not the app session's wallet
        // CACAO. See mintAgentDelegationViaFreshSignIn.
        _mint: () =>
          mintAgentDelegationViaFreshSignIn({ appName, openkeyHost, tinycloudHosts }),
      });
      if (status === "active") {
        agentEnabledRef.current = true;
        setCapability("enabled");
      }
    } catch (err) {
      console.warn("[agent] enablement failed:", err instanceof Error ? err.message : err);
      let msg: string;
      if (err instanceof DOMException && err.name === "NotAllowedError") {
        msg = "Passkey sign was cancelled — tap Enable to try again.";
      } else if (err instanceof TypeError) {
        msg = "Could not reach agent service. Please try again later.";
      } else {
        msg = "Failed to enable agent tools. Please try again.";
      }
      setEnableError(msg);
    } finally {
      setEnabling(false);
    }
  }, [tcw, backendUrl, sessionStore, agentEnabledRef, activeThreadIdRef, appName, openkeyHost, tinycloudHosts]);

  return { capability, enableError, enabling, onEnable, silentlyEnabled };
}
