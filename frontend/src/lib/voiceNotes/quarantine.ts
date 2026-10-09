import { useCallback, useEffect, useState } from "react";

import {
  listQuarantine,
  nativeVoiceNotesAvailable,
  type QuarantinedRecording,
} from "./nativeVoiceNotes";

/** The rejection's code, however the platform spells it (Capacitor's own is upper case). */
export function rejectionCode(caught: unknown): string | null {
  const code =
    typeof caught === "object" && caught !== null
      ? (caught as { code?: unknown }).code
      : undefined;
  return typeof code === "string" ? code.toLowerCase() : null;
}

/** The browser harness and other shells with no quarantine to list: not a failure. Any other rejection (`unimplemented` included) is one. */
export function isUnsupported(caught: unknown): boolean {
  return rejectionCode(caught) === "unsupported";
}

export interface QuarantinedRecordings {
  items: readonly QuarantinedRecording[];
  /** The list could not be read (not for lack of support): the rejection. */
  error: unknown;
  /** Reads the list again. */
  refresh(): void;
}

export type QuarantineRead =
  | { kind: "items"; items: readonly QuarantinedRecording[] }
  | { kind: "failed"; caught: unknown };

/** One read of the quarantine: a shell with no quarantine reads as empty, any other rejection is logged and returned. */
export async function readQuarantine(): Promise<QuarantineRead> {
  try {
    return { kind: "items", items: (await listQuarantine()).items };
  } catch (caught) {
    if (isUnsupported(caught)) return { kind: "items", items: [] };
    console.error("[VoiceNotes] Could not read the quarantine", caught);
    return { kind: "failed", caught };
  }
}

/**
 * The sessions native gave up on and parked with their audio kept. Read on
 * mount, whenever `refreshKey` changes (the caller passes a key that changes
 * when a `recoveryFailed` issue appears), and on `refresh()`.
 */
export function useQuarantinedRecordings(
  enabled: boolean,
  refreshKey = "",
): QuarantinedRecordings {
  const [items, setItems] = useState<readonly QuarantinedRecording[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!enabled || !nativeVoiceNotesAvailable()) return;
    let current = true;
    void readQuarantine().then((read) => {
      if (!current) return;
      if (read.kind === "items") {
        setItems(read.items);
        setError(null);
      } else setError(read.caught);
    });
    return () => {
      current = false;
    };
  }, [enabled, refreshKey, tick]);
  const refresh = useCallback(() => setTick((n) => n + 1), []);
  return { items, error, refresh };
}
