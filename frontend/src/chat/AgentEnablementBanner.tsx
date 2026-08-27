// One-time private-agent consent affordance (C3).
// Rendered as a fixed bottom banner — consistent with the billingNotice pattern.
// Hidden when capability is "unavailable" or "probing". Disappears after enable.
// Provider-agnostic copy: no model/vendor names.

import type { FC } from "react";
import { InfoIcon } from "lucide-react";

import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { AgentCapability } from "./useAgentEnablement";

interface AgentEnablementBannerProps {
  capability: AgentCapability;
  enableError: string | null;
  enabling: boolean;
  onEnable: () => Promise<void>;
  silentlyEnabled?: boolean;
}

export const AgentAccessDetails: FC = () => (
  <div className="space-y-2 text-left text-xs leading-relaxed">
    <p>
      <span className="font-semibold">Agent memory</span>
      <span className="block text-popover-foreground/80">
        Remembers useful preferences and context across conversations.
      </span>
    </p>
    <p>
      <span className="font-semibold">Meeting transcript access</span>
      <span className="block text-popover-foreground/80">
        Lets this private agent read your synced meeting metadata and
        transcripts when you ask about meetings. Transcript access is read-only,
        limited to this agent, and expires after 7 days.
      </span>
    </p>
  </div>
);

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
          Private agent enabled.
        </div>
      </div>
    );
  }

  if (capability !== "available") return null;

  return (
    <div
      role="region"
      aria-label="Agent tools"
      className="fixed bottom-24 left-1/2 z-[60] w-[calc(100%-2rem)] max-w-xl -translate-x-1/2"
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
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5 text-xs font-medium text-popover-foreground">
                <span>Enable private agent</span>
                <TooltipProvider delayDuration={250}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        aria-label="What private agent access includes"
                        className="inline-flex size-5 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <InfoIcon className="size-3.5" aria-hidden="true" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent
                      side="top"
                      sideOffset={8}
                      className="w-80 max-w-[calc(100vw-2rem)] border border-border bg-popover p-3 text-popover-foreground shadow-lg"
                    >
                      <AgentAccessDetails />
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </div>
              <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
                Let your agent remember useful context and answer questions from
                your synced meeting transcripts.
              </p>
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
