// Settings → Voice notes (plan §2.7): the default transcriber for new recordings. Native-only
// (mobile voice notes don't exist on web/desktop), and signed-out capture already locks to
// on-device regardless of this choice (CaptureDefaults.options, CaptureModels.swift/.kt).
import { useEffect, useState, useSyncExternalStore } from "react";

import { SegmentedControl } from "@/components/ui/segmented-control";
import { Button } from "@/components/ui/button";
import { onDeviceSttStore, onDeviceModelLine, primaryOnDeviceModel } from "@/lib/voiceNotes/onDeviceSttStore";
import { OnDeviceStt } from "@/lib/voiceNotes/onDeviceStt";
import { nativeVoiceNotesAvailable, type TranscriberId } from "@/lib/voiceNotes/nativeVoiceNotes";
import { readDefaultTranscriber, setDefaultTranscriber } from "@/lib/voiceNotes/transcriberPreference";

const OPTIONS: { value: TranscriberId; label: string }[] = [
  { value: "off", label: "Off" },
  { value: "on-device", label: "On this phone" },
  { value: "private-cloud", label: "Private cloud" },
];

export function VoiceNotesTranscriberSettings() {
  const [value, setValue] = useState<TranscriberId | null>(null);
  const sttStatus = useSyncExternalStore(onDeviceSttStore.subscribe, onDeviceSttStore.snapshot, onDeviceSttStore.snapshot);
  const model = primaryOnDeviceModel(sttStatus);
  const modelLine = onDeviceModelLine(sttStatus);

  useEffect(() => {
    void readDefaultTranscriber().then(setValue).catch((err: unknown) => console.warn("[VoiceNotes] Could not read the default transcriber", err));
  }, []);

  if (!nativeVoiceNotesAvailable() || value === null) return null;

  const choose = (next: TranscriberId) => {
    setValue(next);
    void setDefaultTranscriber(next).catch((err: unknown) => console.warn("[VoiceNotes] Could not save the default transcriber", err));
  };

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-muted-foreground">New recordings are transcribed this way by default. Each recording can still choose a different route.</p>
      <SegmentedControl<TranscriberId> aria-label="Default transcriber" value={value} onValueChange={choose} options={OPTIONS} />
      {value === "on-device" && (
        <div className="flex items-center justify-between gap-3 text-xs">
          <span className="text-muted-foreground">On-device model: {modelLine.text}</span>
          {model && model.state !== "ready" && model.state !== "checking" && model.state !== "downloading" && model.state !== "queued" && (
            <Button type="button" variant="outline" size="sm" onClick={() => void OnDeviceStt.downloadNow({ allowCellular: false })}>
              Download
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
