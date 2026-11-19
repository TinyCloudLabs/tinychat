// Settings → Meeting summaries: whether a combined meeting starts a summary run on its own.
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { useEffect, useState } from "react";

import { readAutomaticSummaries, writeAutomaticSummaries } from "@/lib/meetingSummary/automaticSummaries";

export function AutomaticSummariesSettings({ tcw }: { tcw: TinyCloudWeb }) {
  // null until the synced value is read: the control stays disabled rather than showing the default.
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    readAutomaticSummaries(tcw)
      .then((value) => live && setEnabled(value))
      .catch(() => live && setError("Could not read this setting."));
    return () => {
      live = false;
    };
  }, [tcw]);

  const change = async (next: boolean) => {
    const previous = enabled;
    setEnabled(next);
    setError(null);
    try {
      await writeAutomaticSummaries(tcw, next);
    } catch {
      setEnabled(previous);
      setError("Could not save this setting. Try again.");
    }
  };

  return (
    <div className="flex flex-col gap-2 text-callout">
      <label className="flex min-h-11 items-center gap-3">
        <input
          type="checkbox"
          className="size-5"
          checked={enabled === true}
          disabled={enabled === null}
          onChange={(event) => void change(event.currentTarget.checked)}
          data-testid="automatic-summaries-toggle"
        />
        <span>Automatic meeting summaries</span>
      </label>
      <p className="text-muted-foreground">
        A summary uses credits like a chat message. Off: combined meetings are saved without a summary, and you start one with Generate.
      </p>
      {error && <p role="alert" className="text-destructive">{error}</p>}
    </div>
  );
}
