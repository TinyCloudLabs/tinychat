// "Transcribe" for a note with no transcript: one button and a small provider chip beside it, Local unless the user picks
// another. Private asks once for consent first. Shown by the screens that know the note can be transcribed (no transcript,
// nothing running); the label is "Try again" after a failure.
import { useContext, useEffect, useId, useRef, useState } from "react";
import { ChevronDownIcon, Loader2Icon } from "lucide-react";

import { HowItWorksLink } from "@/components/ui/how-it-works-link";
import { PlatformContext } from "@/lib/platform";
import { CHECK_AGAIN, PRIVATE_CONSENT_ACTION, PRIVATE_CONSENT_TITLE, privateConsentBody, privateConsentDevice, privateNotOffered, TRANSCRIBER_NAME } from "@/capture/recorder/final/finalCopy";
import type { VoiceNoteTranscriptionProps } from "@/capture/recorder/transcriptionProps";
import { captureCapabilities } from "@/lib/voiceNotes/captureEngine";
import { VoiceNotes } from "@/lib/voiceNotes/nativeVoiceNotes";
import { cn } from "@/lib/utils";
import {
  needsConsent,
  transcribeProviders,
  transcribeWith,
  type PhoneRecording,
  type TranscribeProvider,
} from "./transcribeProviders";

export const PHONE_READ_FAILED = "Couldn’t check whether this note is on this phone.";

// The soft skin's own tokens, with the app's as fallback outside it (the saved-note sheet sits on --solid, where the
// outline variant's border vanishes).
const EDGE = "shadow-[inset_0_0_0_1px_var(--gedge,hsl(var(--input)))]";
const CONTROL = "h-[var(--tc-control-height-sm)] min-h-9 rounded-full text-sm font-semibold";
// The provider chip is a quiet secondary control: smaller than the button, its touch area widened by the select laid over it.
const CHIP = "relative inline-flex h-7 items-center gap-1 rounded-full pl-3 pr-2 text-sm font-medium text-[color:var(--dim,hsl(var(--muted-foreground)))]";

export type PhoneRead = { state: "reading" } | { state: "read"; phone: PhoneRecording | null } | { state: "failed" };

/** Whether this phone holds the note's recording (Local needs it), and the mode it was committed to. */
function usePhoneRecording(noteId: string): PhoneRead {
  const [read, setRead] = useState<PhoneRead>(() => (captureCapabilities().localTranscription ? { state: "reading" } : { state: "read", phone: null }));
  useEffect(() => {
    if (!captureCapabilities().localTranscription) return;
    let live = true;
    setRead({ state: "reading" });
    VoiceNotes.listPending().then(
      ({ recordings }) => {
        if (!live) return;
        const recording = recordings.find((candidate) => candidate.id === noteId);
        setRead({ state: "read", phone: recording ? { committed: recording.options?.transcriber ?? null, hasLocalState: recording.stt != null } : null });
      },
      (caught: unknown) => {
        console.error("[Library] Could not read this phone's recordings for", noteId, caught);
        if (live) setRead({ state: "failed" });
      },
    );
    return () => {
      live = false;
    };
  }, [noteId]);
  return read;
}

export interface TranscribeActionProps {
  noteId: string;
  /** Absent where this build or account has no private cloud. */
  transcription: VoiceNoteTranscriptionProps | undefined;
  /** The note's length: Private is offered only up to the length private cloud advertises. */
  durationSecs: number | null;
  /** "Transcribe" by default; "Try again" after a failure. */
  label?: string;
  className?: string;
}

export function TranscribeAction(props: TranscribeActionProps) {
  return <TranscribeActionFor {...props} read={usePhoneRecording(props.noteId)} />;
}

/** The action given what the phone said about the note. */
export function TranscribeActionFor(props: TranscribeActionProps & { read: PhoneRead }) {
  const platform = useContext(PlatformContext);
  const { noteId, transcription, durationSecs, read } = props;
  const phone = read.state === "read" ? read.phone : null;
  const providers = transcribeProviders(noteId, transcription, phone, durationSecs);
  const [chosen, setChosen] = useState<TranscribeProvider | null>(null);
  const [busy, setBusy] = useState(false);
  // Set at the tap, ahead of any render: the start is still on its way until this note's job or queue entry replaces the action.
  const starting = useRef(false);
  const [asking, setAsking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const selectId = useId();
  // The lock holds while the start is on its way. A job that settles into something other than active (blocked, held,
  // failed, done) is the start's answer: the action stays on screen and the user may try again.
  const jobKind = transcription?.jobs.get(noteId)?.kind;
  useEffect(() => {
    if (jobKind === undefined || jobKind === "active") return;
    starting.current = false;
    setBusy(false);
  }, [jobKind]);
  const provider = chosen !== null && providers.includes(chosen) ? chosen : providers[0];
  const recheck = transcription?.availability === "failed" && transcription.consented ? privateNotOffered("failed") : null;

  const run = (which: TranscribeProvider) => {
    if (starting.current) return;
    starting.current = true;
    setProblem(null);
    setBusy(true);
    const failed = (reason: string) => {
      starting.current = false;
      setProblem(reason);
      setBusy(false);
    };
    void transcribeWith(which, noteId, transcription, phone).then(
      (failure) => {
        if (failure !== null) failed(failure);
      },
      (caught: unknown) => {
        console.error("[Library] Could not start the transcription of", noteId, caught);
        failed("Couldn’t start the transcription. Try again in a moment.");
      },
    );
  };

  // Local needs the phone's answer first, or the default would change under the user.
  if (read.state === "reading") return null;

  if (asking && provider !== undefined) {
    return (
      <div className={cn("flex min-w-0 flex-col gap-3", props.className)} data-testid="transcribe-consent">
        <p className="text-callout text-muted-foreground">
          <strong>{PRIVATE_CONSENT_TITLE}</strong> {privateConsentBody(privateConsentDevice(platform))}
        </p>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <button
            type="button"
            className={cn(CONTROL, "bg-[color:var(--ink,hsl(var(--primary)))] px-4 text-[color:var(--bgc,hsl(var(--primary-foreground)))]")}
            data-testid="transcribe-consent-enable"
            onClick={() => {
              transcription!.onConsent();
              setAsking(false);
              run(provider);
            }}
          >
            {PRIVATE_CONSENT_ACTION}
          </button>
          <button
            type="button"
            className={cn(CONTROL, EDGE, "px-4 text-[color:var(--ink,inherit)]")}
            data-testid="transcribe-consent-dismiss"
            onClick={() => setAsking(false)}
          >
            Not now
          </button>
          <HowItWorksLink section="transcription" />
        </div>
      </div>
    );
  }

  if (provider === undefined && read.state !== "failed" && recheck === null && problem === null) return null;

  return (
    <div className={cn("flex min-w-0 flex-col gap-2", props.className)} data-testid="transcribe-action">
      {provider !== undefined && (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={busy}
            className={cn(CONTROL, "inline-flex items-center gap-2 bg-[color:var(--ink,hsl(var(--primary)))] px-4 text-[color:var(--bgc,hsl(var(--primary-foreground)))] disabled:opacity-60")}
            data-testid="transcribe-button"
            onClick={() => (needsConsent(provider, transcription) ? setAsking(true) : run(provider))}
          >
            {busy && <Loader2Icon className="size-4 shrink-0 motion-safe:animate-spin" aria-hidden />}
            {props.label ?? "Transcribe"}
          </button>
          {providers.length > 1 ? (
            <label className={cn(CHIP, EDGE, "focus-within:ring-2 focus-within:ring-ring")}>
              <span className="sr-only" id={selectId}>Transcribe with</span>
              <span aria-hidden>{TRANSCRIBER_NAME[provider]}</span>
              <ChevronDownIcon className="size-3.5 shrink-0" aria-hidden />
              <select
                aria-labelledby={selectId}
                data-testid="transcribe-provider"
                value={provider}
                disabled={busy}
                onChange={(event) => setChosen(event.target.value as TranscribeProvider)}
                className="absolute inset-x-0 -inset-y-2 h-auto w-full cursor-pointer appearance-none rounded-full bg-transparent text-base opacity-0 focus-visible:outline-none"
              >
                {providers.map((id) => (
                  <option key={id} value={id}>
                    {TRANSCRIBER_NAME[id]}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <span data-testid="transcribe-provider-static" className={cn(CHIP, EDGE, "pr-3")}>
              <span className="sr-only">Transcribe with </span>
              {TRANSCRIBER_NAME[provider]}
            </span>
          )}
        </div>
      )}
      {read.state === "failed" && (
        <p role="alert" className="text-callout text-destructive" data-testid="transcribe-phone-read-failed">
          {PHONE_READ_FAILED}
        </p>
      )}
      {recheck !== null && transcription && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1" data-testid="transcribe-private-recheck">
          <p className="min-w-0 text-callout text-muted-foreground">{TRANSCRIBER_NAME["private-cloud"]}: {recheck.reason}</p>
          <button type="button" className={cn(CONTROL, EDGE, "px-3 text-[color:var(--ink,inherit)]")} onClick={() => void transcription.onRecheck()}>
            {CHECK_AGAIN}
          </button>
        </div>
      )}
      {problem && (
        <p role="alert" className="text-callout text-destructive" data-testid="transcribe-problem">
          {problem}
        </p>
      )}
    </div>
  );
}
