// Upload audio (TC-761): Capture's Upload action opens this sheet, a bottom
// sheet on phones and a dialog on wider screens. Its body is the upload panel
// (chat/AudioUploadPanel.tsx) on the app-wide runner, so closing the sheet
// never stops an upload: the In progress row keeps showing it. Transcribe is
// pinned in the sheet's footer, so it stays on screen on a phone on its side.
import { useState } from "react";
import type { SessionStore } from "@tinyboilerplate/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { AudioUploadPanel } from "@/chat/AudioUploadPanel";
import { Button } from "@/components/ui/button";
import { ResponsiveSheet, ResponsiveSheetBody, ResponsiveSheetFooter } from "@/components/ui/responsive-sheet";
import { pastedTranscriptProblem, savePastedTranscript, PASTED_TRANSCRIPT_MAX_BYTES } from "./pastedTranscript";

export interface UploadSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tcw: TinyCloudWeb;
  backendUrl: string;
  sessionStore: SessionStore;
}

export function UploadPicker({ onChoose }: { onChoose: (choice: "audio" | "paste") => void }) {
  return <div className="flex flex-col gap-3">
    <Button type="button" variant="outline" onClick={() => onChoose("audio")}>Audio file</Button>
    <Button type="button" variant="outline" onClick={() => onChoose("paste")}>Paste a transcript</Button>
  </div>;
}

export function UploadSheet({ open, onOpenChange, tcw, backendUrl, sessionStore }: UploadSheetProps) {
  const [choice, setChoice] = useState<"pick" | "audio" | "paste">("pick");
  const [text, setText] = useState("");
  const [title, setTitle] = useState("");
  const [date, setDate] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const problem = pastedTranscriptProblem(text);
  const close = (next: boolean) => {
    onOpenChange(next);
    if (!next) { setChoice("pick"); setText(""); setTitle(""); setDate(""); setError(null); }
  };
  const submit = async () => {
    if (problem || saving) return;
    setSaving(true);
    setError(null);
    try {
      await savePastedTranscript(tcw, { text, title, date });
      close(false);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Couldn't save the transcript. Try again.");
    } finally { setSaving(false); }
  };
  return (
    <ResponsiveSheet open={open} onOpenChange={close} title={choice === "paste" ? "Paste a transcript" : choice === "audio" ? "Upload audio" : "Upload"} contentProps={{ "data-testid": "upload-sheet" }}>
      {choice === "pick" ? <ResponsiveSheetBody>
        <UploadPicker onChoose={setChoice} />
      </ResponsiveSheetBody> : choice === "audio" ? <>
        <div className="px-5 pt-2"><Button type="button" variant="ghost" onClick={() => setChoice("pick")}>Back</Button></div>
        <AudioUploadPanel tcw={tcw} backendUrl={backendUrl} sessionStore={sessionStore} onDone={() => close(false)} layout="sheet" />
      </> : <>
        <ResponsiveSheetBody>
          <div className="flex flex-col gap-4">
            <Button type="button" variant="ghost" onClick={() => setChoice("pick")} className="self-start">Back</Button>
            <PasteTranscriptFields title={title} date={date} text={text} onTitle={setTitle} onDate={setDate} onText={setText} />
            <p className="text-meta text-muted-foreground">Plain text, speaker lines, or timestamps · maximum {PASTED_TRANSCRIPT_MAX_BYTES / 1_000_000} MB</p>
            {problem && text.trim() && <p role="alert" className="text-meta text-destructive">{problem}</p>}
            {error && <p role="alert" className="text-meta text-destructive">{error}</p>}
          </div>
        </ResponsiveSheetBody>
        <ResponsiveSheetFooter><Button type="button" disabled={problem !== null || saving} onClick={() => void submit()} data-testid="paste-transcript-submit">{saving ? "Saving…" : "Submit"}</Button></ResponsiveSheetFooter>
      </>}
    </ResponsiveSheet>
  );
}

// 16px text on touch fields: a smaller field makes iOS zoom the page when it
// takes focus, and the zoom stays after it loses focus (the composer, the
// notetaker form, the moment field and the note writer follow the same rule).
const FIELD = "rounded-md border bg-background px-3 py-2 text-body fine:text-callout";

function PasteTranscriptFields(props: {
  title: string;
  date: string;
  text: string;
  onTitle: (value: string) => void;
  onDate: (value: string) => void;
  onText: (value: string) => void;
}) {
  return <>
    <label className="flex flex-col gap-1 text-callout">Title (optional)
      <input className={FIELD} value={props.title} onChange={(event) => props.onTitle(event.target.value)} maxLength={200} />
    </label>
    <label className="flex flex-col gap-1 text-callout">Date (optional)
      <input type="date" className={FIELD} value={props.date} onChange={(event) => props.onDate(event.target.value)} />
    </label>
    <label className="flex flex-col gap-1 text-callout">Transcript
      <textarea className={`min-h-64 resize-y ${FIELD}`} value={props.text} onChange={(event) => props.onText(event.target.value)} placeholder="Paste plain text, Speaker: lines, or [mm:ss] timestamps" data-testid="paste-transcript-text" />
    </label>
  </>;
}
