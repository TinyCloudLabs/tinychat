import { useEffect, useRef, useState } from "react";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { readCachedFirstScreen, readFirstScreen, writeFirstScreen, type FirstScreen } from "./firstScreenStore";
import { FIRST_SCREEN_STRINGS as text } from "./firstScreenStrings";

/**
 * The longest the control stays on "Loading…" with nothing cached. Past it the
 * control shows Feed, says the setting could not be loaded, and lets the user
 * choose; a late answer is applied only if they have not chosen meanwhile.
 */
export const FIRST_SCREEN_LOAD_DEADLINE_MS = 8000;

export function FirstScreenControl({ tcw, did }: { tcw: TinyCloudWeb; did?: string | null }) {
  const [choice, setChoice] = useState<FirstScreen | null>(() => readCachedFirstScreen(did));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const chosen = useRef(false);

  useEffect(() => {
    let cancelled = false;
    chosen.current = false;
    const cached = readCachedFirstScreen(did);
    setChoice(cached);
    setError(null);
    const timer = cached ? null : setTimeout(() => {
      if (cancelled || chosen.current) return;
      setChoice((current) => current ?? "feed");
      setError((current) => current ?? text.readError);
    }, FIRST_SCREEN_LOAD_DEADLINE_MS);
    void readFirstScreen(tcw, did).then((screen) => {
      if (cancelled || chosen.current) return;
      setChoice(screen);
      setError((current) => (current === text.readError ? null : current));
    }).catch(() => {
      // A cached value keeps showing what Home really opens on.
      if (cancelled || chosen.current || cached) return;
      setChoice("feed");
      setError(text.readError);
    });
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [tcw, did]);

  async function save(screen: FirstScreen) {
    chosen.current = true;
    setSaving(true);
    setError(null);
    try {
      await writeFirstScreen(tcw, screen, did);
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
