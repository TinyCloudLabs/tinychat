import { useEffect, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { VoiceNotes } from "@/lib/voiceNotes/nativeVoiceNotes";
import { localModelGuide, modelActionLabel } from "@/capture/recorder/final/localModelGuide";
import { isOnDeviceReady, OnDeviceStt } from "@/lib/voiceNotes/onDeviceStt";
import { downloadOnDeviceModel, onDeviceSttStore } from "@/lib/voiceNotes/onDeviceSttStore";
import { FINAL_COPY } from "@/capture/recorder/final/finalCopy";
import { ThemeToggle } from "@/components/theme-toggle";
import { readTranscriberPreference, setDefaultIdentifySpeakers } from "@/lib/voiceNotes/transcriberPreference";

export function LocalSettings({ onBack }: { onBack: () => void }) {
  const [quarantine, setQuarantine] = useState<{ id: string; reason: string }[]>([]);
  const model = useSyncExternalStore(onDeviceSttStore.subscribe, onDeviceSttStore.snapshot, onDeviceSttStore.snapshot);
  const downloadError = useSyncExternalStore(onDeviceSttStore.subscribe, onDeviceSttStore.downloadError, onDeviceSttStore.downloadError);
  const guide = localModelGuide(model, { start: () => void downloadOnDeviceModel(), error: downloadError });
  const [identifySpeakers, setIdentifySpeakers] = useState(() => readTranscriberPreference().identifySpeakers);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    onDeviceSttStore.refresh().catch((caught: unknown) => { if (active) setError(String(caught)); });
    return () => { active = false; };
  }, []);
  return <section aria-label="Local settings" className="space-y-4">
    <Button variant="ghost" onClick={onBack}>Back</Button>
    <h2 className="text-xl font-semibold">Voice notes</h2>
    <p>On this phone</p>
    <p>Sign in to use TinyCloud private or AssemblyAI.</p>
    <div className="rounded-xl border border-border p-4">
      <h3 className="font-medium">On-device transcription model</h3>
      <p role={guide.action?.label === FINAL_COPY.modelTryAgain ? "alert" : undefined}>
        {model.models.length === 0 ? "Checking this phone…" : isOnDeviceReady(model) ? "Ready" : guide.reason}
      </p>
      {model.models.length > 0 && <label className="flex gap-2"><input type="checkbox" checked={model.autoDownload}
        onChange={(event) => { void OnDeviceStt.setAutoDownload({ enabled: event.target.checked }).catch((caught: unknown) => setError(String(caught))); }} />Download on Wi-Fi automatically</label>}
      {guide.action && model.models.length > 0 && !isOnDeviceReady(model) && <Button variant="outline" onClick={guide.action.run}>
        {guide.action.label === FINAL_COPY.modelUnavailable ? "Download now" : modelActionLabel(guide.action)}</Button>}
    </div>
    <label className="flex gap-2"><input type="checkbox" checked={identifySpeakers}
      onChange={(event) => { const next = event.target.checked; void setDefaultIdentifySpeakers(next)
        .then(() => setIdentifySpeakers(next), (caught: unknown) => setError(String(caught))); }} />Identify speakers by default</label>
    <div className="flex items-center gap-3"><span>Appearance</span><ThemeToggle /></div>
    <Button variant="outline" onClick={() => { void VoiceNotes.listQuarantine().then(({ items }) => setQuarantine(items), (caught: unknown) => setError(String(caught))); }}>Recordings Exo couldn't recover</Button>
    {quarantine.map((item) => <p key={item.id}>{item.reason} <Button variant="outline" onClick={() => { void VoiceNotes.deleteQuarantined({ id: item.id }).then(() => setQuarantine((items) => items.filter((other) => other.id !== item.id)), (caught: unknown) => setError(String(caught))); }}>Delete</Button></p>)}
    {error && <p role="alert">{error}</p>}
  </section>;
}
