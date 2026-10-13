import { useEffect, useState } from "react";
import { cachedAudioSize, clearCachedAudio } from "@/lib/voiceNotes/audioPlaybackCache";
import { installCaptureEngine } from "@/lib/voiceNotes/captureEngine";
import { readableError } from "@/lib/readableError";

const sizeText = (bytes: number) => bytes >= 1024 * 1024 * 1024
  ? `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
  : `${Math.round(bytes / (1024 * 1024))} MB`;

export function AudioCacheSettings() {
  const [size, setSize] = useState<{ bytes: number; limit: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void installCaptureEngine().then(cachedAudioSize).then(setSize, (caught: unknown) => setError(readableError(caught)));
  }, []);
  const clear = async () => {
    setBusy(true);
    setError(null);
    try { await clearCachedAudio(); setSize(await cachedAudioSize()); }
    catch (caught) { setError(readableError(caught)); }
    finally { setBusy(false); }
  };
  return <section aria-label="Audio cache" className="space-y-2">
    <h3 className="font-medium">Cached audio</h3>
    <p className="text-sm text-muted-foreground" data-testid="cached-audio-size">
      {size ? `${sizeText(size.bytes)} of ${sizeText(size.limit)} used` : "Checking cache size…"}
    </p>
    <p className="text-sm text-muted-foreground">Recordings stored in your space stay on this device for faster playback.</p>
    <button type="button" className="text-sm underline disabled:opacity-50" disabled={busy || !size || size.bytes === 0} onClick={() => void clear()}>
      {busy ? "Clearing…" : "Clear cached audio"}
    </button>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </section>;
}
