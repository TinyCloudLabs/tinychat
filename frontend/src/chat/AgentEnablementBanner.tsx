// One-time "Enable agent memory & tools" affordance (C3).
// Rendered as a fixed bottom banner — consistent with the billingNotice pattern.
// Hidden when capability is "unavailable" or "probing". Disappears after enable.
// Provider-agnostic copy: no model/vendor names.

import type { FC } from "react";
import type { AgentCapability } from "./useAgentEnablement";

interface AgentEnablementBannerProps {
  capability: AgentCapability;
  enableError: string | null;
  enabling: boolean;
  onEnable: () => Promise<void>;
  silentlyEnabled?: boolean;
}

export const AgentEnablementBanner: FC<AgentEnablementBannerProps> = ({
  capability,
  enableError,
  enabling,
  onEnable,
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

  return (
    <div
      role="region"
      aria-label="Agent tools"
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
              {enabling ? "Enabling…" : "Retry"}
            </button>
          </>
        ) : (
          <>
            <div className="flex flex-col gap-0.5">
              <span className="text-xs text-muted-foreground">
                Enable agent memory &amp; tools
              </span>
              <span className="text-[11px] leading-none text-muted-foreground/70">
                You&apos;ll be prompted to sign with your passkey once to authorize access.
              </span>
            </div>
            <button
              type="button"
              onClick={() => void onEnable()}
              disabled={enabling}
              className="shrink-0 rounded-md bg-primary px-3 py-1 text-xs font-semibold text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {enabling ? "Enabling…" : "Enable"}
            </button>
          </>
        )}
      </div>
    </div>
  );
};
