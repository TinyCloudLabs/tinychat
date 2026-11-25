// Settings → Voice notes: whether a transcribed voice note gets names suggested for its speakers on its own.
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { useEffect, useState } from "react";

import { SPEAKER_NAMES_COPY as COPY } from "@/capture/library/speakerNamesCopy";
import { readSuggestSpeakerNames, writeSuggestSpeakerNames } from "@/lib/speakerNaming/suggestSpeakerNames";

export function SuggestSpeakerNamesSettings({ tcw }: { tcw: TinyCloudWeb }) {
  // null until the synced value is read: the control stays disabled rather than showing the default.
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    readSuggestSpeakerNames(tcw)
      .then((value) => live && setEnabled(value))
      .catch(() => live && setError(COPY.settingUnread));
    return () => {
      live = false;
    };
  }, [tcw]);

  const change = async (next: boolean) => {
    const previous = enabled;
    setEnabled(next);
    setError(null);
    try {
      await writeSuggestSpeakerNames(tcw, next);
    } catch {
      setEnabled(previous);
      setError(COPY.settingUnsaved);
    }
  };

  return (
    <div className="mt-3 flex flex-col gap-2 text-callout">
      <label className="flex min-h-11 items-center gap-3">
        <input
          type="checkbox"
          className="size-5"
          checked={enabled === true}
          disabled={enabled === null}
          onChange={(event) => void change(event.currentTarget.checked)}
          data-testid="suggest-speaker-names-toggle"
        />
        <span>{COPY.setting}</span>
      </label>
      <p className="text-muted-foreground">{COPY.settingHelp}</p>
      {error && <p role="alert" className="text-destructive">{error}</p>}
    </div>
  );
}
