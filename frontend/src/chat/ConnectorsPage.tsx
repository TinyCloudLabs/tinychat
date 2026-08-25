import type { SessionStore } from "@tinyboilerplate/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { ArrowLeftIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ConnectorsCard } from "./ConnectorsCard";
import { TranscriberSection } from "./TranscriberSection";

interface ConnectorsPageProps {
  tcw: TinyCloudWeb;
  backendUrl: string;
  sessionStore: SessionStore;
  onBack: () => void;
  /**
   * The cohort meeting archive is owned by App because App owns the signed-in
   * session. It stays optional: outside the backend-ingest cohort the section
   * returns null and leaves no empty placeholder behind.
   */
  meetingsSlot?: React.ReactNode;
}

/**
 * First-class home for external meeting sources and capture tools.
 *
 * This deliberately follows TinyChat's existing narrow, card-based page
 * language. Connectors are promoted in the app hierarchy without importing a
 * dashboard shell or a second visual system.
 */
export function ConnectorsPage({
  tcw,
  backendUrl,
  sessionStore,
  onBack,
  meetingsSlot,
}: ConnectorsPageProps) {
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-2xl px-4 py-6 pb-[max(1.5rem,env(safe-area-inset-bottom))] sm:px-6">
        <div className="mb-4 flex items-center justify-between gap-3">
          <Button
            variant="outline"
            size="sm"
            aria-label="Back to chat"
            onClick={onBack}
            className="h-11 gap-1.5 px-2 md:h-8 sm:px-3"
          >
            <ArrowLeftIcon className="size-4" />
            <span className="hidden sm:inline">Back to chat</span>
          </Button>
          <h1 className="text-base font-semibold tracking-tight">Connectors</h1>
        </div>

        <p className="mb-4 text-sm leading-relaxed text-muted-foreground">
          Bring meeting notes and transcripts into your private space. You
          choose each source, when it syncs, and when its access ends.
        </p>

        <div className="flex flex-col gap-4">
          <ConnectorsCard
            tcw={tcw}
            backendUrl={backendUrl}
            sessionStore={sessionStore}
            title="Meeting sources"
          />
          <TranscriberSection
            backendUrl={backendUrl}
            sessionStore={sessionStore}
            tcw={tcw}
          />
          {meetingsSlot}
        </div>
      </div>
    </div>
  );
}
