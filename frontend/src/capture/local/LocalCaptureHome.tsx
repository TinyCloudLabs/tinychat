import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useRecorder } from "@/capture/recorder/RecorderProvider";
import { LocalNoteDetail } from "./LocalNoteDetail";
import { LocalNoteRow } from "./LocalNoteRow";
import { LocalSettings } from "./LocalSettings";
import { EarlierVersionNotes } from "./EarlierVersionNotes";
import { LOCAL_ONLY_COPY } from "./localCopy";
import { useLocalNotes } from "./useLocalNotes";

export function LocalCaptureHome({ did = null, offline = false, onSignIn, onRetry }: {
  did?: string | null; offline?: boolean; onSignIn?: () => void; onRetry?: () => void;
}) {
  const recorder = useRecorder();
  const { notes, error, refresh, remove } = useLocalNotes(did, offline);
  const [detail, setDetail] = useState<string | null>(null);
  const [settings, setSettings] = useState(false);
  const selected = notes.find((note) => note.id === detail);
  if (selected) return <LocalNoteDetail note={selected} onBack={() => setDetail(null)} onDelete={remove} />;
  if (settings) return <LocalSettings onBack={() => setSettings(false)} />;
  const earlier = notes.filter((note) => note.ownerUnknown);
  const current = notes.filter((note) => !note.ownerUnknown);
  return <section aria-label="Capture on this phone" className="mx-auto w-full max-w-xl space-y-5 p-5" data-testid="local-capture-home">
    <header className="flex items-start justify-between gap-3">
      <div><h1 className="text-2xl font-semibold">On this phone</h1><p className="text-sm text-muted-foreground">{LOCAL_ONLY_COPY}</p></div>
      <Button variant="ghost" aria-label="Local settings" onClick={() => setSettings(true)}>Settings</Button>
    </header>
    {offline ? <div><p>You're offline.</p><Button variant="outline" onClick={onRetry}>Try again</Button></div>
      : <Button variant="outline" onClick={onSignIn}>Sign in to sync</Button>}
    <Button className="w-full" onClick={recorder.record} disabled={!recorder.ready || !recorder.available}>Record</Button>
    {recorder.error && <p role="alert">{recorder.error}</p>}
    {error && <p role="alert">{error}</p>}
    <div className="space-y-2">{current.map((note) => <LocalNoteRow key={note.id} note={note} onOpen={() => setDetail(note.id)} />)}</div>
    <EarlierVersionNotes notes={earlier} did={did} onChange={refresh} onDelete={remove} />
  </section>;
}
