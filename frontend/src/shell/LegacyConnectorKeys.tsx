// Connectors, older keys: shown above Connectors only while a connector key is still sealed to the whole network. The
// stored header decides, every time Connectors opens (lib/connectors/legacyKeyReseal.ts), so "Not now" asks again the
// next time. Nothing else on the page waits on it.
import { useEffect, useId, useState } from "react";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { Button } from "@/components/ui/button";
import { probeConnectorKeys, resolveLegacyConnectorKeys, type LegacyKeysOutcome } from "@/lib/connectors/legacyKeyReseal";
import {
  FEATURE_ACCESS_CONTINUE, FEATURE_ACCESS_NOT_NOW, LEGACY_KEYS_BODY, LEGACY_KEYS_DECLINED, LEGACY_KEYS_FAILED, LEGACY_KEYS_MOVED,
  LEGACY_KEYS_NOTHING, LEGACY_KEYS_RETRY, LEGACY_KEYS_TITLE,
} from "@/lib/homeStrings";

type Phase = "probing" | "none" | "ask" | "asking" | LegacyKeysOutcome;

const OUTCOME_LINE: Partial<Record<Phase, string>> = {
  moved: LEGACY_KEYS_MOVED,
  nothing: LEGACY_KEYS_NOTHING,
  declined: LEGACY_KEYS_DECLINED,
  failed: LEGACY_KEYS_FAILED,
};

type LegacyKeysTcw = Pick<TinyCloudWeb, "secrets" | "kv" | "session" | "setRuntimePermissionSigner" | "requestPermissions" | "hasPermissions">;

export function LegacyConnectorKeys({ tcw, address }: { tcw: LegacyKeysTcw; address: string }) {
  const [phase, setPhase] = useState<Phase>("probing");
  const headingId = useId();
  useEffect(() => {
    let current = true;
    setPhase("probing");
    void probeConnectorKeys(tcw).then(
      (states) => { if (current) setPhase(Object.values(states).includes("legacy") ? "ask" : "none"); },
      () => { if (current) setPhase("none"); },
    );
    return () => { current = false; };
  }, [tcw]);
  if (phase === "probing" || phase === "none") return null;
  const ask = async () => {
    setPhase("asking");
    setPhase(await resolveLegacyConnectorKeys(tcw, address).catch((): LegacyKeysOutcome => "failed"));
  };
  const line = OUTCOME_LINE[phase];
  return (
    <section aria-labelledby={headingId} data-testid="legacy-connector-keys" className="mx-auto my-6 flex w-full max-w-md flex-col gap-3 rounded-xl border bg-card p-5">
      <h2 id={headingId} className="text-base font-semibold">{LEGACY_KEYS_TITLE}</h2>
      {line ? <p role="status" className="text-sm text-muted-foreground">{line}</p> : <p className="text-sm text-muted-foreground">{LEGACY_KEYS_BODY}</p>}
      {(phase === "ask" || phase === "asking") && (
        <div className="flex items-center gap-2">
          <Button className="rounded-full" disabled={phase === "asking"} onClick={() => void ask()}>{FEATURE_ACCESS_CONTINUE}</Button>
          <Button variant="ghost" disabled={phase === "asking"} onClick={() => setPhase("declined")}>{FEATURE_ACCESS_NOT_NOW}</Button>
        </div>
      )}
      {phase === "failed" && <div><Button className="rounded-full" onClick={() => void ask()}>{LEGACY_KEYS_RETRY}</Button></div>}
    </section>
  );
}
