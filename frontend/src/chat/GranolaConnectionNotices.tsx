import { ChevronRightIcon } from "lucide-react";
import { useRef, useState } from "react";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { isSecretsUnlocked, unlockSecrets } from "@/lib/connectors/connectorSecrets";
import { clearGranolaKey } from "@/lib/connectors/granolaSync";
import { secretsAvailable } from "@/lib/openkeyNative";
import { readBackgroundDrainGeneration } from "./useBackgroundDrain";

export function GranolaSummariesNotice({ className }: { className: string }) {
  return (
    <div className={className} role="status" data-testid="granola-summaries-only">
      <b>Summaries only.</b> Your Granola workspace admin turned transcripts off, so only each note’s summary syncs.
    </div>
  );
}

export function GranolaReconnect({ tcw, onReconnect, className, disabled }: {
  tcw: TinyCloudWeb;
  onReconnect: () => void;
  className: string;
  disabled: boolean;
}) {
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  if (!secretsAvailable()) return null;

  const reconnect = async () => {
    if (disabled || pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(false);
    const generation = readBackgroundDrainGeneration();
    const current = () => generation === readBackgroundDrainGeneration();
    try {
      if (!isSecretsUnlocked(tcw) && !(await unlockSecrets(tcw)).ok) {
        if (current()) setError(true);
        return;
      }
      const cleared = await clearGranolaKey(tcw, current);
      if (!current()) return;
      if (cleared) onReconnect();
      else setError(true);
    } catch {
      if (current()) setError(true);
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };

  return (
    <>
      <button type="button" className={className} disabled={disabled || busy} onClick={() => void reconnect()}>
        Reconnect Granola <ChevronRightIcon aria-hidden="true" />
      </button>
      {error && <p className="text-xs text-destructive" role="alert">Couldn't remove the saved Granola key. Try again.</p>}
    </>
  );
}
