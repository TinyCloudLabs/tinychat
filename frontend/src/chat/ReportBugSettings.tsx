import { useEffect, useState } from "react";
import { BugIcon } from "lucide-react";
import { appPlatform } from "@/lib/platform";
import { REPORT_BUG_ENABLED, requestReportBug, setOfferAfterScreenshot, useOfferAfterScreenshot } from "@/lib/reportBug/config";
import { nativeScreenshotReport } from "@/lib/reportBug/nativeScreenshot";
import { REPORT_BUG_STRINGS as S } from "@/lib/reportBug/strings";

/**
 * Settings → Report a bug (TC-3716), beside the privacy policy link: the row opens the sheet; the offer toggle
 * shows only where a screenshot can be noticed (iPhone, Android 14+, and the browser and Mac app's keyboard signs).
 */
export function ReportBugSettings({ enabled = REPORT_BUG_ENABLED }: { enabled?: boolean }) {
  const offer = useOfferAfterScreenshot();
  const [detects, setDetects] = useState(() => appPlatform() === "web" || appPlatform() === "tauri");
  useEffect(() => {
    const plugin = enabled ? nativeScreenshotReport() : null;
    if (!plugin) return;
    let live = true;
    void plugin.isSupported().then(({ supported }) => { if (live) setDetects(supported); }, () => {});
    return () => { live = false; };
  }, [enabled]);
  if (!enabled) return null;
  return (
    <div className="mt-1 flex flex-col gap-2">
      <button type="button" onClick={requestReportBug}
        className="inline-flex min-h-11 w-fit items-center gap-1 text-meta font-medium text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring fine:min-h-0">
        <BugIcon className="size-3.5" aria-hidden="true" />
        {S.settingsRow}
      </button>
      {detects && (
        <div>
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm font-medium">{S.settingsToggle}</p>
            <button type="button" role="switch" aria-checked={offer} aria-label={S.settingsToggle}
              onClick={() => setOfferAfterScreenshot(!offer)}
              className="-my-2.5 flex h-11 w-12 shrink-0 items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring fine:my-0 fine:h-6 fine:w-11">
              <span aria-hidden className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${offer ? "bg-primary" : "bg-muted"}`}>
                <span className={`absolute top-1 size-4 rounded-full bg-background transition-transform ${offer ? "left-6" : "left-1"}`} />
              </span>
            </button>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">{S.toggleHelper}</p>
        </div>
      )}
    </div>
  );
}
