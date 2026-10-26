import { useEffect, useState } from "react";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { readFirstScreen, writeFirstScreen, type FirstScreen } from "./firstScreenStore";
import { FIRST_SCREEN_STRINGS as text } from "./firstScreenStrings";

export function FirstScreenControl({ tcw }: { tcw: TinyCloudWeb }) {
  const [choice, setChoice] = useState<FirstScreen | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setChoice(null);
    void readFirstScreen(tcw).then((screen) => {
      if (!cancelled) setChoice(screen);
    }).catch(() => {
      if (!cancelled) { setChoice("feed"); setError(text.readError); }
    });
    return () => { cancelled = true; };
  }, [tcw]);

  async function save(screen: FirstScreen) {
    setSaving(true);
    setError(null);
    try {
      await writeFirstScreen(tcw, screen);
      setChoice(screen);
    } catch {
      setError(text.error);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex items-center justify-between gap-4">
      <div>
        <label htmlFor="home-first-screen" className="text-sm font-medium">{text.heading}</label>
        <p className="text-xs text-muted-foreground">{text.hint}</p>
        {error && <p role="alert" className="mt-2 text-xs text-destructive">{error}</p>}
      </div>
      {choice === null ? <span className="text-xs text-muted-foreground">{text.loading}</span> : (
        <select id="home-first-screen" value={choice} disabled={saving}
          onChange={(event) => void save(event.target.value as FirstScreen)}
          className="min-h-11 rounded-lg border border-border bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50">
          <option value="feed">{text.feed}</option>
          <option value="apps">{text.apps}</option>
        </select>
      )}
    </div>
  );
}
