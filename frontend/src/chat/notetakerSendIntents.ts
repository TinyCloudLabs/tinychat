const SEND_INTENT_PREFIX = "tinychat.notetaker.send.v2:";
const SEND_KEY_RE = /^manual-v1-[0-9a-f-]{36}$/;

type SendIntentStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export interface SendIntent {
  key: string;
  input: { meeting_url: string; bot_name?: string };
  createdAt: number;
  /** The terminal meeting whose explicit resend started this intent. */
  afterMeetingId?: string;
}
const sendIntentStorage = (): SendIntentStorage | null => {
  try { return window.sessionStorage; } catch { return null; }
};
const sendIntentStorageKey = (owner: string, normalizedUrl: string) =>
  `${SEND_INTENT_PREFIX}${encodeURIComponent(owner.toLowerCase())}:${encodeURIComponent(normalizedUrl)}`;
const memorySendIntents = new Map<string, SendIntent>();

function validStoredIntent(raw: string | null): SendIntent | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<SendIntent>;
    // A tampered or truncated row is discarded rather than retried: the backend refuses a
    // malformed Idempotency-Key, which would otherwise wedge this URL for the whole session.
    if (!SEND_KEY_RE.test(value.key ?? "") || typeof value.input?.meeting_url !== "string"
      || value.input.meeting_url.length === 0
      || (value.input.bot_name !== undefined && typeof value.input.bot_name !== "string")
      || (value.createdAt !== undefined && (!Number.isFinite(value.createdAt) || value.createdAt! < 0))
      || (value.afterMeetingId !== undefined && typeof value.afterMeetingId !== "string")) return null;
    return { ...value, createdAt: value.createdAt ?? 0 } as SendIntent;
  } catch {
    return null;
  }
}

export function getOrCreateSendIntent(
  normalizedUrl: string,
  input: SendIntent["input"],
  afterMeetingId?: string,
  storage = sendIntentStorage(),
  owner = "",
): SendIntent {
  const storageKey = sendIntentStorageKey(owner, normalizedUrl);
  let stored: string | null = null;
  try { stored = storage?.getItem(storageKey) ?? null; } catch { /* Memory still works. */ }
  const existing = memorySendIntents.get(storageKey) ?? validStoredIntent(stored);
  const intent = existing
    ?? { key: `manual-v1-${crypto.randomUUID()}`, input, createdAt: Date.now(), ...(afterMeetingId ? { afterMeetingId } : {}) };
  memorySendIntents.set(storageKey, intent);
  try { storage?.setItem(storageKey, JSON.stringify(intent)); } catch { /* Memory still works. */ }
  return intent;
}

export function clearSendIntentKey(normalizedUrl: string, storage = sendIntentStorage(), owner = ""): void {
  const key = sendIntentStorageKey(owner, normalizedUrl);
  memorySendIntents.delete(key);
  try { storage?.removeItem(key); } catch { /* Already clear for this component. */ }
}

/** Remove one account's durable and memory-only send intents during sign-out. */
export function clearSendIntentsForOwner(owner: string, storage: Storage | null = sendIntentStorage() as Storage | null): void {
  const prefix = `${SEND_INTENT_PREFIX}${encodeURIComponent(owner.toLowerCase())}:`;
  for (const key of memorySendIntents.keys()) if (key.startsWith(prefix)) memorySendIntents.delete(key);
  if (!storage) return;
  try {
    const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index))
      .filter((key): key is string => key !== null && key.startsWith(prefix));
    for (const key of keys) storage.removeItem(key);
  } catch { /* Sign-out must continue when browser storage is unavailable. */ }
}
