import { useEffect, useState } from "react";
import { cachedAudioSize, clearCachedAudio } from "@/lib/voiceNotes/audioPlaybackCache";
import { reconcileAudioCache, subscribeAudioCacheAccount } from "@/lib/voiceNotes/audioReceiptUpgrade";
import { installCaptureEngine } from "@/lib/voiceNotes/captureEngine";
import { readableError } from "@/lib/readableError";
import { Button } from "@/components/ui/button";

const sizeText = (bytes: number) => bytes >= 1024 * 1024 * 1024
  ? `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
  : `${Math.round(bytes / (1024 * 1024))} MB`;

export function AudioCacheSettings() {
  const [size, setSize] = useState<{ bytes: number; pinnedBytes: number; limit: number } | null>(null);
  const [clearSummary, setClearSummary] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    let revision = 0;
    const refresh = () => {
      const current = ++revision;
      void installCaptureEngine().then(() => reconcileAudioCache(undefined, true)).then(cachedAudioSize)
        .then((value) => { if (active && current === revision) setSize(value); },
          (caught: unknown) => { if (active && current === revision) setError(readableError(caught)); });
    };
    const unsubscribe = subscribeAudioCacheAccount(refresh);
    refresh();
    return () => { active = false; unsubscribe(); };
  }, []);
  const clear = async () => {
    setBusy(true);
    setError(null);
    setClearSummary(null);
    try {
      const report = await clearCachedAudio();
      setSize(await cachedAudioSize());
      setClearSummary(report.stopped === "account_changed"
        ? "Cache clear stopped because the signed-in account changed."
        : `Cleared ${report.cleared} items; ${report.inUse} pinned or in use (${sizeText(report.pinnedBytes)}).`);
    } catch (caught) { setError(readableError(caught)); }
    finally { setBusy(false); }
  };
  return <section aria-label="Audio cache" className="space-y-2">
    <h3 className="font-medium">Cached audio</h3>
    <p className="text-sm text-muted-foreground" data-testid="cached-audio-size">
      {size ? `${sizeText(size.bytes)} of ${sizeText(size.limit)} available to clear` : "Checking cache size…"}
    </p>
    {size && size.pinnedBytes > 0 && <p className="text-sm text-muted-foreground" data-testid="cached-audio-pinned">
      {sizeText(size.pinnedBytes)} pinned for transcription or other local work.
    </p>}
    <p className="text-sm text-muted-foreground">Recordings stored in your space stay on this device for faster playback.</p>
    <Button type="button" variant="link" size="sm" className="h-11 px-0 text-sm underline fine:h-8"
      disabled={busy || !size || (size.bytes === 0 && size.pinnedBytes === 0)} onClick={() => void clear()}>
      {busy ? "Clearing…" : "Clear cached audio"}
    </Button>
    {clearSummary && <p className="text-sm text-muted-foreground" role="status">{clearSummary}</p>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </section>;
}
