import { useState } from "react";
import { Button } from "@/components/ui/button";
import { VoiceNotes, type VoiceNoteRecording } from "@/lib/voiceNotes/nativeVoiceNotes";

export function EarlierVersionNotes({ notes, did, onChange, onDelete }: {
  notes: VoiceNoteRecording[]; did: string | null; onChange: () => Promise<void>; onDelete: (id: string) => Promise<void>;
}) {
  const [error, setError] = useState<string | null>(null);
  if (!notes.length) return null;
  const attempt = (job: () => Promise<void>) => { void job().then(() => setError(null), (caught: unknown) => setError(String(caught))); };
  return <section aria-label="Notes from an earlier version" className="space-y-3">
    <h2 className="text-lg font-semibold">Notes from an earlier version</h2>
    <p>These notes need an account choice before they can be saved to your space.</p>
    {notes.map((note) => <div key={note.id} className="rounded-xl border border-border p-3">
      <p>Voice note · {new Date(note.startedAt).toLocaleString()}</p>
      <div className="mt-2 flex gap-2">
        {did && <Button onClick={() => attempt(async () => { await VoiceNotes.claim({ id: note.id, did, evidence: "user_choice" }); await onChange(); })}>Save to this account</Button>}
        <Button variant="outline" onClick={() => attempt(() => onDelete(note.id))}>Delete from this phone</Button>
      </div>
    </div>)}
    {error && <p role="alert">{error}</p>}
  </section>;
}
