// Settings → Transcription: the default engine for Upload audio, and whose
// AssemblyAI account transcribes: TinyCloud's (the default, C10) or the user's
// own API key (validated with AssemblyAI before it is saved to the encrypted
// TinyCloud secrets, like the Fireflies key in ConnectorDialog).

import { useEffect, useState, type FC, type ReactNode } from "react";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { AudioLinesIcon, ExternalLinkIcon, Loader2Icon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { HowItWorksLink } from "@/components/ui/how-it-works-link";
import { InfoTip } from "@/components/ui/info-tip";
import { SectionCard } from "@/components/ui/section-card";
import {
  ASSEMBLYAI_API_KEY_URL,
  AssemblyAiError,
  createAssemblyAiClient,
  readAssemblyAiKey,
  readAssemblyAiKeyHint,
  readAssemblyAiKeyMode,
  removeAssemblyAiKey,
  saveAssemblyAiKey,
  writeAssemblyAiKeyMode,
  type AssemblyAiKeyMode,
  type AssemblyAiKeyStatus,
} from "@/lib/assemblyai";
import { readDefaultUploadEngine, UPLOAD_ENGINE_LABELS, writeDefaultUploadEngine, type UploadEngine } from "@/lib/audioUpload";
import { isSecretsUnlocked } from "@/lib/connectors/connectorSecrets";

export type KeyPhase = "idle" | "checking" | "validating" | "saving" | "removing";

/** A segment: 44 px tall on touch, compact with a mouse. */
const SEGMENT = "min-h-11 rounded px-3 py-1 text-xs fine:min-h-0";

const KEY_MODE_LABELS: Readonly<Record<AssemblyAiKeyMode, string>> = {
  hosted: "TinyCloud's AssemblyAI account",
  own: "My own API key",
};

export interface TranscriptionSettingsViewProps {
  engine: UploadEngine;
  keyMode: AssemblyAiKeyMode;
  keyStatus: AssemblyAiKeyStatus;
  phase: KeyPhase;
  keyInput: string;
  error: string | null;
  onEngineChange: (engine: UploadEngine) => void;
  onKeyModeChange: (mode: AssemblyAiKeyMode) => void;
  onKeyInputChange: (value: string) => void;
  onSaveKey: () => void;
  onRemoveKey: () => void;
  onCheckKey: () => void;
  /** The link to How it works → Where your audio goes (a router link, so the view itself renders without one). */
  howItWorks?: ReactNode;
}

export const TranscriptionSettingsView: FC<TranscriptionSettingsViewProps> = ({
  engine,
  keyMode,
  keyStatus,
  phase,
  keyInput,
  error,
  onEngineChange,
  onKeyModeChange,
  onKeyInputChange,
  onSaveKey,
  onRemoveKey,
  onCheckKey,
  howItWorks,
}) => {
  const busy = phase !== "idle";
  return (
    <SectionCard icon={AudioLinesIcon} title="Transcription">
      <div className="flex flex-col gap-1.5">
        <span className="flex items-center text-xs text-muted-foreground">
          Default engine for uploaded audio
          <InfoTip label="About the default engine" className="-my-3 fine:-my-1">
            You can still pick the other engine for each upload.
          </InfoTip>
        </span>
        <div role="radiogroup" aria-label="Default transcription engine" className="inline-flex w-fit rounded-md border p-0.5">
          {(["private-cloud", "assemblyai"] as const).map((e) => (
            <button
              key={e}
              type="button"
              role="radio"
              aria-checked={engine === e}
              onClick={() => onEngineChange(e)}
              className={`${SEGMENT} ${engine === e ? "bg-primary text-primary-foreground" : "text-muted-foreground"}`}
            >
              {UPLOAD_ENGINE_LABELS[e]}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-4 flex flex-col gap-2">
        <span className="text-xs font-medium">AssemblyAI</span>
        <div role="radiogroup" aria-label="AssemblyAI account" className="inline-flex w-fit flex-wrap rounded-md border p-0.5">
          {(["hosted", "own"] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={keyMode === m}
              onClick={() => onKeyModeChange(m)}
              className={`${SEGMENT} ${keyMode === m ? "bg-primary text-primary-foreground" : "text-muted-foreground"}`}
            >
              {KEY_MODE_LABELS[m]}
            </button>
          ))}
        </div>
        {/* One sentence on where uploads go; the rest (deletion, the key's one
            trip to Exo's server) is How it works → Where your audio goes. */}
        <p className="text-xs text-muted-foreground">
          {keyMode === "hosted"
            ? "Uploads go through Exo’s server to AssemblyAI, under TinyCloud’s account. No key needed."
            : "Uploads go from this device to AssemblyAI under your own key, kept in your encrypted TinyCloud secrets."}
        </p>
        {howItWorks}
        {keyMode === "hosted" ? null : keyStatus === "saved" ? (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs">A key is saved.</span>
            <Button type="button" size="sm" variant="outline" onClick={onRemoveKey} disabled={busy} className="gap-1.5">
              {phase === "removing" && <Loader2Icon className="size-3.5 animate-spin" />}
              {phase === "removing" ? "Removing…" : "Remove key"}
            </Button>
          </div>
        ) : (
          <form
            className="flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (!busy && keyInput.trim().length > 0) onSaveKey();
            }}
          >
            <label htmlFor="assemblyai-api-key" className="sr-only">
              AssemblyAI API key
            </label>
            <div className="flex flex-col gap-2 sm:flex-row">
              <input
                id="assemblyai-api-key"
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={keyInput}
                disabled={busy}
                onChange={(e) => onKeyInputChange(e.target.value)}
                placeholder="AssemblyAI API key"
                // 16 px and 44 px on touch (no iOS focus zoom); compact with a mouse.
                className="h-11 w-full rounded-md border border-input bg-background px-3 text-body shadow-sm outline-none placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-60 fine:h-9 fine:text-sm sm:max-w-xs"
              />
              <Button type="submit" size="sm" disabled={busy || keyInput.trim().length === 0} className="gap-1.5 fine:h-9">
                {(phase === "validating" || phase === "saving") && <Loader2Icon className="size-4 animate-spin" />}
                {phase === "validating" ? "Checking with AssemblyAI…" : phase === "saving" ? "Saving…" : "Verify and save"}
              </Button>
            </div>
            <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
              <a
                href={ASSEMBLYAI_API_KEY_URL}
                target="_blank"
                rel="noreferrer"
                className="inline-flex min-h-11 items-center gap-1 text-primary underline-offset-4 hover:underline fine:min-h-0"
              >
                Find your API key
                <ExternalLinkIcon className="size-3" aria-hidden />
              </a>
              {keyStatus === "unknown" && (
                <button type="button" onClick={onCheckKey} disabled={busy} className="min-h-11 underline disabled:opacity-60 fine:min-h-0">
                  {phase === "checking" ? "Checking your secrets…" : "Already saved one? Unlock to check"}
                </button>
              )}
            </p>
          </form>
        )}
        {error !== null && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
      </div>
    </SectionCard>
  );
};

export const TranscriptionSettings: FC<{ tcw: TinyCloudWeb }> = ({ tcw }) => {
  const [engine, setEngine] = useState<UploadEngine>(readDefaultUploadEngine);
  const [keyMode, setKeyMode] = useState<AssemblyAiKeyMode>(readAssemblyAiKeyMode);
  const [keyStatus, setKeyStatus] = useState<AssemblyAiKeyStatus>(readAssemblyAiKeyHint);
  const [phase, setPhase] = useState<KeyPhase>("idle");
  const [keyInput, setKeyInput] = useState("");
  const [error, setError] = useState<string | null>(null);

  // With the vault already open the saved key is read without a prompt.
  useEffect(() => {
    if (!isSecretsUnlocked(tcw)) return;
    let cancelled = false;
    void readAssemblyAiKey(tcw).then((r) => {
      if (!cancelled && r.ok) setKeyStatus(r.data !== null ? "saved" : "none");
    });
    return () => {
      cancelled = true;
    };
  }, [tcw]);

  const onCheckKey = async () => {
    setError(null);
    setPhase("checking");
    const read = await readAssemblyAiKey(tcw);
    setPhase("idle");
    if (!read.ok) setError(read.message);
    else setKeyStatus(read.data !== null ? "saved" : "none");
  };

  // Validate first: an unchecked key is never stored.
  const onSaveKey = async () => {
    const key = keyInput.trim();
    setError(null);
    setPhase("validating");
    try {
      await createAssemblyAiClient(key).validateKey();
    } catch (err) {
      setPhase("idle");
      setError(
        err instanceof AssemblyAiError && err.kind === "invalid-key"
          ? "AssemblyAI rejected this API key."
          : err instanceof AssemblyAiError && err.kind === "network"
            ? "Couldn't reach AssemblyAI to check the key. Try again."
            : err instanceof Error
              ? err.message
              : String(err),
      );
      return;
    }
    setPhase("saving");
    const saved = await saveAssemblyAiKey(tcw, key);
    setPhase("idle");
    if (!saved.ok) {
      setError(saved.message);
      return;
    }
    setKeyInput("");
    setKeyStatus("saved");
  };

  const onRemoveKey = async () => {
    setError(null);
    setPhase("removing");
    const removed = await removeAssemblyAiKey(tcw);
    setPhase("idle");
    if (!removed.ok) setError(removed.message);
    else setKeyStatus("none");
  };

  return (
    <TranscriptionSettingsView
      engine={engine}
      keyMode={keyMode}
      onKeyModeChange={(m) => {
        setKeyMode(m);
        writeAssemblyAiKeyMode(m);
        setError(null);
      }}
      keyStatus={keyStatus}
      phase={phase}
      keyInput={keyInput}
      error={error}
      onEngineChange={(e) => {
        setEngine(e);
        writeDefaultUploadEngine(e);
      }}
      onKeyInputChange={setKeyInput}
      onSaveKey={() => void onSaveKey()}
      onRemoveKey={() => void onRemoveKey()}
      onCheckKey={() => void onCheckKey()}
      howItWorks={<HowItWorksLink section="transcription" className="-mt-2 w-fit fine:mt-0" />}
    />
  );
};
