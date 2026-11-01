// Settings > TinyCloud: the toggle for the SDK's floating button (hidden by default) and a row that opens the panel.
import { CloudIcon } from "lucide-react";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { Button } from "@/components/ui/button";
import { SectionCard } from "@/components/ui/section-card";
import { isReplicationAvailable } from "../lib/replication/replicationFlag";
import { setTinyCloudButtonShown, useTinyCloudButtonShown } from "../lib/tinycloudButton";

export const TINYCLOUD_COPY = {
  title: "TinyCloud",
  toggleLabel: "Show the TinyCloud button",
  toggleHelp: "A small button in the corner that opens your TinyCloud panel.",
  rowLabel: "TinyCloud panel",
  // The panel's Local copy section (sync) exists only where local replication is available.
  rowDescription: "Your storage, permissions and sync, in one place.",
  rowDescriptionNoSync: "Your storage and permissions, in one place.",
  openButton: "Open",
} as const;

export function TinyCloudSettings({ tcw }: { tcw: TinyCloudWeb }) {
  const shown = useTinyCloudButtonShown();
  return (
    <SectionCard icon={CloudIcon} title={TINYCLOUD_COPY.title}>
      <div data-testid="tinycloud-button-setting-row" className="mb-4 flex items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p id="tinycloud-button-label" className="text-sm font-medium">{TINYCLOUD_COPY.toggleLabel}</p>
          <p className="text-xs text-muted-foreground">{TINYCLOUD_COPY.toggleHelp}</p>
        </div>
        {/* A 44 px target on touch around the 44x24 track. */}
        <button type="button" role="switch" aria-checked={shown} aria-labelledby="tinycloud-button-label" onClick={() => setTinyCloudButtonShown(!shown)} className="-my-2.5 flex h-11 w-12 shrink-0 items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring fine:my-0 fine:h-6 fine:w-11">
          <span aria-hidden className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${shown ? "bg-primary" : "bg-muted"}`}>
            <span className={`absolute top-1 size-4 rounded-full bg-background transition-transform ${shown ? "left-6" : "left-1"}`} />
          </span>
        </button>
      </div>
      <div data-testid="tinycloud-panel-row" className="flex items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">{TINYCLOUD_COPY.rowLabel}</p>
          <p className="text-xs text-muted-foreground">{isReplicationAvailable() ? TINYCLOUD_COPY.rowDescription : TINYCLOUD_COPY.rowDescriptionNoSync}</p>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={() => tcw.ui.open()}>{TINYCLOUD_COPY.openButton}</Button>
      </div>
    </SectionCard>
  );
}
