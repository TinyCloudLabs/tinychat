// Settings → Transcription: the default engine for Upload audio, and the
// user's own AssemblyAI API key (validated with AssemblyAI before it is saved
// to the encrypted TinyCloud secrets, like the Fireflies key in ConnectorDialog).

import { useEffect, useState, type FC } from "react";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { AudioLinesIcon, ExternalLinkIcon, Loader2Icon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { SectionCard } from "@/components/ui/section-card";
import {
  ASSEMBLYAI_API_KEY_URL,
  AssemblyAiError,
  createAssemblyAiClient,
  readAssemblyAiKey,
  readAssemblyAiKeyHint,
  removeAssemblyAiKey,
  saveAssemblyAiKey,
  type AssemblyAiKeyStatus,
} from "@/lib/assemblyai";
import { readDefaultUploadEngine, UPLOAD_ENGINE_LABELS, writeDefaultUploadEngine, type UploadEngine } from "@/lib/audioUpload";
import { isSecretsUnlocked } from "@/lib/connectors/connectorSecrets";

export type KeyPhase = "idle" | "checking" | "validating" | "saving" | "removing";

export interface TranscriptionSettingsViewProps {
  engine: UploadEngine;
  keyStatus: AssemblyAiKeyStatus;
  phase: KeyPhase;
  keyInput: string;
  error: string | null;
  onEngineChange: (engine: UploadEngine) => void;
  onKeyInputChange: (value: string) => void;
  onSaveKey: () => void;
  onRemoveKey: () => void;
  onCheckKey: () => void;
}

export const TranscriptionSettingsView: FC<TranscriptionSettingsViewProps> = ({
  engine,
  keyStatus,
  phase,
  keyInput,
  error,
  onEngineChange,
  onKeyInputChange,
  onSaveKey,
  onRemoveKey,
  onCheckKey,
}) => {
  const busy = phase !== "idle";
  return (
    <SectionCard icon={AudioLinesIcon} title="Transcription">
      <div className="flex flex-col gap-1.5">
        <span className="text-xs text-muted-foreground">Default engine for uploaded audio</span>
        <div role="radiogroup" aria-label="Default transcription engine" className="inline-flex w-fit rounded-md border p-0.5">
          {(["private-cloud", "assemblyai"] as const).map((e) => (
            <button
              key={e}
              type="button"
              role="radio"
              aria-checked={engine === e}
              onClick={() => onEngineChange(e)}
              className={`rounded px-3 py-1 text-xs ${engine === e ? "bg-primary text-primary-foreground" : "text-muted-foreground"}`}
            >
              {UPLOAD_ENGINE_LABELS[e]}
            </button>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">You can still pick the other engine for each upload.</p>
      </div>

      <div className="mt-4 flex flex-col gap-2">
        <span className="text-xs font-medium">AssemblyAI API key</span>
        <p className="text-xs text-muted-foreground">
          Optional. With your own key, uploads can be transcribed by AssemblyAI. The key is kept in your encrypted
          TinyCloud secrets and sent from this device to AssemblyAI. To delete a finished transcript at AssemblyAI,
          Exo&apos;s server forwards the key there once; it never stores or logs it.
        </p>
        {keyStatus === "saved" ? (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs">A key is saved.</span>
            <Button type="button" size="sm" variant="outline" onClick={onRemoveKey} disabled={busy} className="h-8 gap-1.5">
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
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm shadow-sm outline-none placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-60 sm:max-w-xs"
              />
              <Button type="submit" size="sm" disabled={busy || keyInput.trim().length === 0} className="h-9 gap-1.5">
                {(phase === "validating" || phase === "saving") && <Loader2Icon className="size-4 animate-spin" />}
                {phase === "validating" ? "Checking with AssemblyAI…" : phase === "saving" ? "Saving…" : "Verify and save"}
              </Button>
            </div>
            <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
              <a
                href={ASSEMBLYAI_API_KEY_URL}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-primary underline-offset-4 hover:underline"
              >
                Find your API key
                <ExternalLinkIcon className="size-3" aria-hidden />
              </a>
              {keyStatus === "unknown" && (
                <button type="button" onClick={onCheckKey} disabled={busy} className="underline disabled:opacity-60">
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
    />
  );
};
