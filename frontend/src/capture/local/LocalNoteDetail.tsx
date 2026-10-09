import { useEffect, useState } from "react";
import { Capacitor } from "@capacitor/core";
import { Button } from "@/components/ui/button";
import { VoiceNotes, type LocalTranscript, type VoiceNoteRecording } from "@/lib/voiceNotes/nativeVoiceNotes";

export function LocalNoteDetail({ note, onBack, onDelete }: {
  note: VoiceNoteRecording; onBack: () => void; onDelete: (id: string) => Promise<void>;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<LocalTranscript | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void Promise.all([VoiceNotes.localAudioUrl({ id: note.id }), VoiceNotes.getTranscript({ id: note.id })]).then(
      ([audio, text]) => { if (active) { setUrl(Capacitor.convertFileSrc(audio.url)); setTranscript(text.transcript); } },
      (caught: unknown) => { if (active) setError(caught instanceof Error ? caught.message : String(caught)); },
    );
    return () => { active = false; };
  }, [note.id]);
  return <section aria-label="Note on this phone" className="space-y-4">
    <Button variant="ghost" onClick={onBack}>Back</Button>
    <h2 className="text-xl font-semibold">Voice note</h2>
    {url && <audio controls src={url} className="w-full" />}
    {transcript?.segments.map((segment, index) => <p key={index}>{segment.speaker && `${segment.speaker}: `}{segment.text}</p>)}
    {error && <p role="alert">{error}</p>}
    <Button variant="destructive" onClick={() => { void onDelete(note.id).then(onBack, (caught: unknown) => setError(String(caught))); }}>Delete from this phone</Button>
  </section>;
}
