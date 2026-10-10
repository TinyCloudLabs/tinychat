import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { VoiceNotes } from "@/lib/voiceNotes/nativeVoiceNotes";
import { OnDeviceStt, type OnDeviceSttStatus } from "@/lib/voiceNotes/onDeviceStt";
import { ThemeToggle } from "@/components/theme-toggle";
import { readTranscriberPreference, setDefaultIdentifySpeakers } from "@/lib/voiceNotes/transcriberPreference";

export function LocalSettings({ onBack }: { onBack: () => void }) {
  const [quarantine, setQuarantine] = useState<{ id: string; reason: string }[]>([]);
  const [model, setModel] = useState<OnDeviceSttStatus | null>(null);
  const [identifySpeakers, setIdentifySpeakers] = useState(() => readTranscriberPreference().identifySpeakers);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void OnDeviceStt.status().then((status) => { if (active) setModel(status); }, (caught: unknown) => { if (active) setError(String(caught)); });
    const listener = OnDeviceStt.addListener("status", (status) => { if (active) setModel(status); });
    return () => { active = false; void listener.then((handle) => handle.remove()); };
  }, []);
  return <section aria-label="Local settings" className="space-y-4">
    <Button variant="ghost" onClick={onBack}>Back</Button>
    <h2 className="text-xl font-semibold">Voice notes</h2>
    <p>On this phone</p>
    <p>Sign in to use TinyCloud private or AssemblyAI.</p>
    <div className="rounded-xl border border-border p-4">
      <h3 className="font-medium">On-device transcription model</h3>
      <p>{model?.models.find((entry) => entry.id.includes("parakeet"))?.state ?? "Checking this phone…"}</p>
      {model && <label className="flex gap-2"><input type="checkbox" checked={model.autoDownload}
        onChange={(event) => { void OnDeviceStt.setAutoDownload({ enabled: event.target.checked }).catch((caught: unknown) => setError(String(caught))); }} />Download on Wi-Fi automatically</label>}
      <Button variant="outline" onClick={() => { void OnDeviceStt.downloadNow({ allowCellular: false }).catch((caught: unknown) => setError(String(caught))); }}>Download now</Button>
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
