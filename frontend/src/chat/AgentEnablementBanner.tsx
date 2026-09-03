// Agent access enablement + renewal affordance (C3).
// Rendered as a fixed bottom banner — consistent with the billingNotice pattern.
// Hidden when capability is "unavailable" or "probing". Disappears after enable
// and returns with explicit reconnect copy if a private-data tool reports expiry.
// Provider-agnostic copy: no model/vendor names.

import type { FC } from "react";
import type { AgentCapability } from "./useAgentEnablement";
import type { AgentDelegationErrorCode } from "../lib/agentChatApi";

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
        className="fixed bottom-24 left-1/2 z-[60] -translate-x-1/2"
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
  const action = reconnecting ? "Reconnect" : "Enable";

  return (
    <div
      role="region"
      aria-label="Agent tools"
      aria-live="polite"
      aria-atomic="true"
      className="fixed bottom-24 left-1/2 z-[60] -translate-x-1/2"
    >
      <div className="flex items-center gap-3 rounded-lg border border-border bg-popover px-4 py-2.5 text-sm text-popover-foreground shadow-lg">
        {enableError ? (
          <>
            <span className="text-xs text-destructive">{enableError}</span>
            <button
              type="button"
              onClick={() => void onEnable()}
              disabled={enabling}
              className="shrink-0 rounded-md bg-primary px-3 py-1 text-xs font-semibold text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {enabling ? `${reconnecting ? "Reconnecting" : "Enabling"}…` : "Retry"}
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
                  : "Enable agent memory & tools"}
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
              className="shrink-0 rounded-md bg-primary px-3 py-1 text-xs font-semibold text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {enabling ? `${reconnecting ? "Reconnecting" : "Enabling"}…` : action}
            </button>
          </>
        )}
      </div>
    </div>
  );
};
