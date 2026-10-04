// Agent access enablement + renewal affordance (C3).
// Rendered as a fixed bottom banner — consistent with the billingNotice pattern.
// Hidden when capability is "unavailable" or "probing". Disappears after enable
// and returns with explicit reconnect copy if a private-data tool reports expiry.
// Provider-agnostic copy: no model/vendor names.

import type { FC } from "react";
import { useLocation } from "react-router-dom";
import { useAgentAccess, type AgentCapability, type UseAgentEnablementResult } from "./useAgentEnablement";
import type { AgentDelegationErrorCode } from "../lib/agentChatApi";
import { isChatViewPath } from "./chatViewPath";

interface AgentEnablementBannerProps {
  capability: AgentCapability;
  enableError: string | null;
  enabling: boolean;
  onEnable: () => Promise<void>;
  reconnectReason: AgentDelegationErrorCode | "delegation_stale" | null;
  silentlyEnabled?: boolean;
}

export const AgentEnablementBanner: FC<AgentEnablementBannerProps> = ({
  capability,
  enableError,
  enabling,
  onEnable,
  reconnectReason,
  silentlyEnabled,
}) => {
  if (capability === "probing" || capability === "unavailable") return null;

  if (capability === "enabled" && silentlyEnabled) {
    return (
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="fixed bottom-[calc(6rem+env(safe-area-inset-bottom))] left-1/2 z-[60] -translate-x-1/2"
      >
        <div className="flex items-center gap-2 rounded-lg border border-border bg-popover px-4 py-2.5 text-sm text-popover-foreground shadow-lg">
          <span className="size-1.5 rounded-full bg-green-500" />
          Agent tools active.
        </div>
      </div>
    );
  }

  if (capability !== "available") return null;

  const reconnecting = reconnectReason !== null;
  const action = reconnecting ? "Reconnect agent" : "Connect agent";

  // Phones get the full width, with the text above a full-width button: a
  // `left-1/2` box only has half the viewport to lay out in, which squeezed
  // the prompt into a narrow column. From `sm` up it is the original centred
  // row.
  return (
    <div
      role="region"
      aria-label="Agent tools"
      aria-live="polite"
      aria-atomic="true"
      className="fixed bottom-[calc(6rem+env(safe-area-inset-bottom))] left-3 right-3 z-[60] sm:left-1/2 sm:right-auto sm:-translate-x-1/2"
    >
      <div className="flex flex-col gap-2 rounded-lg border border-border bg-popover px-4 py-2.5 text-sm text-popover-foreground shadow-lg sm:flex-row sm:items-center sm:gap-3">
        {enableError ? (
          <>
            <span className="text-xs text-destructive">{enableError}</span>
            <button
              type="button"
              onClick={() => void onEnable()}
              disabled={enabling}
              className="min-h-11 shrink-0 rounded-md bg-primary px-3 py-1 text-xs font-semibold text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 disabled:cursor-not-allowed sm:min-h-0"
            >
              {enabling ? `${reconnecting ? "Reconnecting" : "Connecting"}…` : "Retry"}
            </button>
          </>
        ) : (
          <>
            <div className="flex flex-col gap-0.5">
              <span className="text-xs text-muted-foreground">
                {reconnecting
                  ? reconnectReason === "delegation_expired"
                    ? "Private agent access expired"
                    : "Private agent access needs reconnecting"
                  : "Connect private agent access"}
              </span>
              <span className="text-[11px] leading-none text-muted-foreground/70">
                {reconnecting
                  ? "Reconnect to let the agent read your private meeting transcripts again."
                  : "You'll be prompted to sign with your passkey once to authorize access."}
              </span>
            </div>
            <button
              type="button"
              onClick={() => void onEnable()}
              disabled={enabling}
              className="min-h-11 shrink-0 rounded-md bg-primary px-3 py-1 text-xs font-semibold text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 disabled:cursor-not-allowed sm:min-h-0"
            >
              {enabling ? `${reconnecting ? "Reconnecting" : "Connecting"}…` : action}
            </button>
          </>
        )}
      </div>
    </div>
  );
};

/**
 * The banner as the chat workspace mounts it: on chat views only (see
 * isChatViewPath), never over Connectors, Settings, redirects or unknown
 * `/chat/*` links. Visibility only — the enclosing AgentAccessProvider keeps
 * its state across navigation.
 */
export function ChatViewAgentEnablementBanner() {
  const { pathname } = useLocation();
  const { capability, enableError, enabling, onEnable, reconnectReason, silentlyEnabled } = useAgentAccess();
  if (!isChatViewPath(pathname)) return null;
  return (
    <AgentEnablementBanner
      capability={capability}
      enableError={enableError}
      enabling={enabling}
      onEnable={onEnable}
      reconnectReason={reconnectReason}
      silentlyEnabled={silentlyEnabled}
    />
  );
}


/** Settings retains these controls even while access is already connected. */
export function AgentAccessControls(props: UseAgentEnablementResult) {
  const connected = props.capability === "enabled";
  const unknown = props.status === null;
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">Controls private agent memory and meeting access. Public web search stays available.</p>
      <p role="status" className="text-xs font-medium">
        {props.disconnecting ? "Disconnecting…" : connected ? "Connected" : unknown ? "Access status unknown" : "Disconnected"}
      </p>
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={() => void props.onEnable()}
          disabled={props.enabling || props.disconnecting || props.capability === "probing"}
          className="rounded-md bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50">
          {props.enabling ? "Connecting…" : connected ? "Reconnect agent" : "Connect agent"}
        </button>
        {(connected || props.disconnecting || unknown) && <button type="button" onClick={() => void props.onDisconnect()}
          disabled={props.disconnecting || props.capability === "probing"}
          className="rounded-md border border-border px-3 py-2 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-50">
          {props.disconnecting ? "Disconnecting…" : unknown ? "Retry disconnect" : "Disconnect agent"}
        </button>}
      </div>
      {props.enableError && <p role="alert" className="text-xs text-destructive">{props.enableError}</p>}
    </div>
  );
}
