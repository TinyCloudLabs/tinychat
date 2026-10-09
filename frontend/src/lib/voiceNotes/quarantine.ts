import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { captureEngineAvailable } from "./captureEngine";
import { listQuarantine, type QuarantinedRecording } from "./nativeVoiceNotes";

// The account the recorder is attached for. The browser engine lists every parked recording with its owner;
// native lists none with one, and shows them all as before.
let account: string | null = null;
const accountListeners = new Set<() => void>();

/** The recorder controller calls this on attach, so parked recordings are re-read and filtered for the account it serves. */
export function setQuarantineAccount(did: string | null): void {
  if (did === account) return;
  account = did;
  for (const listener of accountListeners) listener();
}

const subscribeAccount = (listener: () => void) => {
  accountListeners.add(listener);
  return () => {
    accountListeners.delete(listener);
  };
};
const readAccount = () => account;

/** What `did` may see of the parked recordings: its own and the unclaimed. Native lists no owner, so it shows all. */
export function quarantinedFor(
  items: readonly QuarantinedRecording[],
  did: string | null,
): readonly QuarantinedRecording[] {
  return items.filter((item) => item.owner == null || item.owner === did);
}

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
 * Runs `read` one at a time. A request made while a read is pending marks it
 * dirty, and exactly one more read runs after the pending one: the extra read
 * can't predate the request, and requests that pile up share it.
 */
export function createCoalescedReader<T>(
  read: () => Promise<T>,
  apply: (result: T) => void,
): () => void {
  let pending = false;
  let dirty = false;
  const run = (): void => {
    pending = true;
    dirty = false;
    void read()
      .then(apply)
      .finally(() => {
        pending = false;
        if (dirty) run();
      });
  };
  return () => {
    if (pending) dirty = true;
    else run();
  };
}

/**
 * The sessions native gave up on and parked with their audio kept. Read on
 * mount, whenever `refreshKey` changes (the caller passes a key that changes
 * when a `recoveryFailed` issue appears), and on `refresh()`. Reads never
 * overlap, and a request made during one gets one read after it.
 */
export function useQuarantinedRecordings(
  enabled: boolean,
  refreshKey = "",
): QuarantinedRecordings {
  const [listed, setItems] = useState<readonly QuarantinedRecording[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [tick, setTick] = useState(0);
  const accountDid = useSyncExternalStore(subscribeAccount, readAccount, readAccount);
  const mounted = useRef(true);
  const apply = useRef((read: QuarantineRead) => {
    if (!mounted.current) return;
    if (read.kind === "items") {
      setItems(read.items);
      setError(null);
    } else setError(read.caught);
  });
  const request = useRef<(() => void) | null>(null);
  request.current ??= createCoalescedReader(readQuarantine, (read) =>
    apply.current(read),
  );
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!enabled || !captureEngineAvailable()) return;
    request.current?.();
  }, [enabled, refreshKey, tick, accountDid]);
  const refresh = useCallback(() => setTick((n) => n + 1), []);
  const items = useMemo(() => quarantinedFor(listed, accountDid), [listed, accountDid]);
  return { items, error, refresh };
}
