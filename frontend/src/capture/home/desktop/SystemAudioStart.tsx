import { useContext, useId, useRef, useState, type ReactNode, type Ref } from "react";
import { Button } from "@/components/ui/button";
import { SheetDialog } from "@/capture/recorder/final/SheetDialog";
import { PlatformContext } from "@/lib/platform";
import { getDesktopCaptureExtras, type DesktopCaptureExtras } from "@/lib/voiceNotes/desktopCaptureExtras";
import { useRecorder } from "@/capture/recorder/RecorderProvider";
import { chooseSystemAudio, needsSystemAudioDisclosure, SYSTEM_AUDIO_BODY, SYSTEM_AUDIO_MIC_ONLY, SYSTEM_AUDIO_RECORD, SYSTEM_AUDIO_TITLE } from "./systemAudioDisclosure";
import { DESKTOP_HOME_COPY } from "./desktopCopy";
import "./systemAudioStart.css";

/** Starts only after the Mac's saved system-audio choice has been checked. */
export function SystemAudioStart(props: { renderTrigger?: (onClick: () => void, disabled: boolean, ref: Ref<HTMLButtonElement>) => ReactNode }) {
  const recorder = useRecorder();
  const platform = useContext(PlatformContext);
  const [disclosureOpen, setDisclosureOpen] = useState(false);
  const [disclosureExtras, setDisclosureExtras] = useState<DesktopCaptureExtras | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const start = async () => {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    try {
      if (platform !== "tauri") { recorder.record(); return; }
      const extras = getDesktopCaptureExtras();
      if (!extras) throw new Error("system_audio_consent_unavailable");
      if (await needsSystemAudioDisclosure(extras)) {
        setDisclosureExtras(extras);
        setDisclosureOpen(true);
      } else recorder.record();
    } catch (error) {
      console.error("[Capture] Could not check system audio consent", error);
      setProblem(`Could not start recording: ${error instanceof Error ? error.message : String(error)}`);
    } finally { setBusy(false); }
  };
  const choose = async (choice: "record" | "mic-only") => {
    if (!disclosureExtras || busy) return;
    setBusy(true);
    setProblem(null);
    try {
      await chooseSystemAudio(disclosureExtras, choice);
      setDisclosureOpen(false);
      recorder.record();
    } catch (error) {
      console.error("[Capture] Could not save system audio consent", error);
      setProblem(`Could not save your choice: ${error instanceof Error ? error.message : String(error)}`);
    } finally { setBusy(false); }
  };
  return <>
    {props.renderTrigger ? props.renderTrigger(() => void start(), !recorder.ready || busy, opener) : <button ref={opener} type="button" className="dch-start" onClick={() => void start()} disabled={!recorder.ready || busy} aria-label={DESKTOP_HOME_COPY.startLabel} data-testid="voice-note-record">
      <i className="dch-dot" aria-hidden="true" />{DESKTOP_HOME_COPY.start}
    </button>}
    {problem && !disclosureOpen && <p role="alert">{problem}</p>}
    {disclosureOpen && <div className="dch-system-audio" data-testid="system-audio-disclosure">
      <SheetDialog role="dialog" titleId={titleId} descriptionId={descriptionId} title={SYSTEM_AUDIO_TITLE} description={SYSTEM_AUDIO_BODY} onCancel={() => setDisclosureOpen(false)} returnFocus={opener}>
        {problem && <p role="alert">{problem}</p>}
        <div className="dch-system-audio-actions">
          <Button type="button" variant="outline" data-initial="" disabled={busy} onClick={() => void choose("mic-only")}>{SYSTEM_AUDIO_MIC_ONLY}</Button>
          <Button type="button" disabled={busy} onClick={() => void choose("record")}>{SYSTEM_AUDIO_RECORD}</Button>
        </div>
      </SheetDialog>
    </div>}
  </>;
}
