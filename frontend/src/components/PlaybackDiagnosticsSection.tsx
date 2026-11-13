// Playback diagnostics in Settings (TC-2857). Hidden: the build line reveals it after seven taps, and it stays shown
// while diagnostics are on so they can be turned off. See lib/audio/playbackDiagnostics.ts for what is recorded.
import { useContext, useRef, useState, useSyncExternalStore } from "react";

import { BuildInfoLine } from "@/components/BuildInfoLine";
import { Button } from "@/components/ui/button";
import {
  clearPlaybackDiagnostics,
  playbackDiagnosticsCount,
  playbackDiagnosticsEnabled,
  playbackDiagnosticsText,
  setPlaybackDiagnosticsEnabled,
  subscribePlaybackDiagnostics,
} from "@/lib/audio/playbackDiagnostics";
import { resolveBuildInfo } from "@/lib/buildInfo";
import { copyText } from "@/lib/copyText";
import { PlatformContext, type AppPlatform } from "@/lib/platform";

/** Taps on the build line, within REVEAL_WINDOW_MS of the first, that reveal the section. */
const REVEAL_TAPS = 7;
const REVEAL_WINDOW_MS = 4000;

/** The foot of Settings: the build line, and the playback diagnostics it reveals. */
export function SettingsBuildFooter() {
  const platform = useContext(PlatformContext);
  const enabled = useSyncExternalStore(subscribePlaybackDiagnostics, playbackDiagnosticsEnabled, playbackDiagnosticsEnabled);
  const [revealed, setRevealed] = useState(false);
  const taps = useRef<number[]>([]);
  return (
    <>
      <div onClickCapture={() => {
        const now = Date.now();
        taps.current = [...taps.current.filter((at) => now - at < REVEAL_WINDOW_MS), now];
        if (taps.current.length >= REVEAL_TAPS) setRevealed(true);
      }}>
        <BuildInfoLine />
      </div>
      {(revealed || enabled) && <PlaybackDiagnosticsSection platform={platform} />}
    </>
  );
}

export function PlaybackDiagnosticsSection({ platform }: { platform: AppPlatform }) {
  const enabled = useSyncExternalStore(subscribePlaybackDiagnostics, playbackDiagnosticsEnabled, playbackDiagnosticsEnabled);
  const count = useSyncExternalStore(subscribePlaybackDiagnostics, playbackDiagnosticsCount, playbackDiagnosticsCount);
  const [status, setStatus] = useState<string | null>(null);
  const exportLog = async (share: boolean) => {
    const text = playbackDiagnosticsText({ build: await resolveBuildInfo(platform).catch(() => null) });
    if (share && typeof navigator.share === "function") {
      try {
        await navigator.share({ title: "TinyCloud Home playback diagnostics", text });
        return;
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
      }
    }
    setStatus((await copyText(text)) ? "Copied the log." : "Couldn't copy the log.");
  };
  return (
    <section aria-labelledby="playback-diagnostics-title" className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-center gap-3">
        <h2 id="playback-diagnostics-title" className="flex-1 text-sm font-semibold">Playback diagnostics</h2>
        <button type="button" role="switch" aria-checked={enabled} aria-label="Record playback diagnostics"
          onClick={() => { setPlaybackDiagnosticsEnabled(!enabled); setStatus(null); }}
          className="flex h-11 w-12 shrink-0 items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <span aria-hidden className={`relative h-6 w-11 rounded-full transition-colors ${enabled ? "bg-primary" : "bg-muted"}`}>
            <span className={`absolute top-1 size-4 rounded-full bg-background transition-transform ${enabled ? "left-6" : "left-1"}`} />
          </span>
        </button>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        Records how note audio plays on this device: audio route changes, player events, timing and device heat. It
        records no note content and stays on this device until you share it. Turn it on, open the note, play it, then
        share the log.
      </p>
      <p className="mt-2 text-xs text-muted-foreground">{count} entries</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" variant="outline" disabled={count === 0} onClick={() => void exportLog(true)}>Share log</Button>
        <Button size="sm" variant="outline" disabled={count === 0} onClick={() => void exportLog(false)}>Copy log</Button>
        <Button size="sm" variant="ghost" disabled={count === 0} onClick={() => { clearPlaybackDiagnostics(); setStatus(null); }}>Clear</Button>
      </div>
      {status && <p role="status" className="mt-2 text-xs text-muted-foreground">{status}</p>}
    </section>
  );
}
