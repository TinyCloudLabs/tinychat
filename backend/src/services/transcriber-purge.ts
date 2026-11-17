import { TranscriptionApiError, type TranscriptionApiClient } from "./transcription-api.js";
import type { TranscriberIndexEntries, TranscriberIndexStore } from "./transcriber-index.js";
import { redactedErrorMessage } from "./webhook-tokens.js";

/**
 * TC-3136: removing a notetaker recording (or deleting the account) must delete the copy the capture
 * provider holds, and prove it. The proof is the private transcription API's own read-back: it deletes
 * its row last, and only after it has verified the provider's recordings, transcript and objects are
 * gone, so "meeting not found" here means the whole chain is gone. Anything else is "failed": the
 * index entry stays (shown as "deleting") and the sweeper retries with backoff until the read-back
 * says not-found. Nothing is dropped silently, and every step is idempotent.
 */

export type PurgeOutcome =
  /** The upstream read-back says not-found: the recording is gone. */
  | "gone"
  /** This address did not create it, so there is nothing of its own to purge (list-only removal). */
  | "not_ours"
  /** Not confirmed gone. The caller keeps the entry and lets the sweeper retry. */
  | "failed";

type PurgeApi = Pick<TranscriptionApiClient, "getMeeting" | "deleteMeeting">;

/** Tries made inside one request: the first at once, then short pauses (bounded; the sweeper takes over). */
export const REQUEST_PURGE_DELAYS_MS = [0, 400, 1_500];
const SWEEP_BASE_DELAY_MS = 30_000;
const SWEEP_MAX_DELAY_MS = 60 * 60_000;
/** Attempts after which every retry is logged at error level, so a stuck purge is surfaced to operators. */
const ESCALATE_AFTER_ATTEMPTS = 5;

export const purgeBackoffMs = (attempts: number): number =>
  Math.min(SWEEP_BASE_DELAY_MS * 2 ** Math.max(0, attempts - 1), SWEEP_MAX_DELAY_MS);

const isNotFound = (error: unknown): boolean => error instanceof TranscriptionApiError && error.status === 404;

class PurgeUnconfirmed extends Error {
  constructor() {
    super("purge_unconfirmed");
  }
}

/** One pass: positive ownership, delete (404 = already gone), then read back. Throws when unconfirmed. */
async function purgeOnce(api: PurgeApi, address: string, id: string): Promise<"gone" | "not_ours"> {
  try {
    const owner = (await api.getMeeting(id)).metadata?.tinychat_address;
    if (typeof owner !== "string" || owner.toLowerCase() !== address.toLowerCase()) return "not_ours";
  } catch (error) {
    if (isNotFound(error)) return "gone";
    throw error;
  }
  try {
    await api.deleteMeeting(id);
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
  try {
    await api.getMeeting(id);
  } catch (error) {
    if (isNotFound(error)) return "gone";
    throw error;
  }
  throw new PurgeUnconfirmed();
}

export async function purgeMeeting(
  api: PurgeApi,
  address: string,
  id: string,
  options: { delaysMs?: number[]; sleep?: (ms: number) => Promise<void> } = {},
): Promise<PurgeOutcome> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const delays = options.delaysMs ?? REQUEST_PURGE_DELAYS_MS;
  let last: unknown;
  for (const delay of delays) {
    if (delay > 0) await sleep(delay);
    try {
      return await purgeOnce(api, address, id);
    } catch (error) {
      last = error;
    }
  }
  // No meeting id or address in logs.
  console.warn(`[transcriber] purge_unconfirmed err=${last instanceof PurgeUnconfirmed ? "still_readable" : redactedErrorMessage(last)}`);
  return "failed";
}

/**
 * Retries every purge the owner already asked for. It keeps the addresses with work in memory (seeded
 * from one scan of the index at start, then fed by `track`) so an idle tick reads nothing.
 */
export class PurgeSweeper {
  private readonly addresses = new Set<string>();
  private timer?: ReturnType<typeof setInterval>;
  private running = false;

  constructor(
    private readonly api: PurgeApi,
    private readonly index: TranscriberIndexStore,
    private readonly options: { intervalMs?: number; now?: () => number } = {},
  ) {}

  /** A removal could not be confirmed: retry it for this address. */
  track(address: string): void {
    this.addresses.add(address.toLowerCase());
  }

  async seed(): Promise<void> {
    for (const address of await this.index.listAddresses()) {
      try {
        if ((await this.index.entries(address)).purging !== undefined) this.track(address);
      } catch {
        // An unreadable address is retried at the next start; it cannot be swept without its index.
        console.warn("[transcriber] purge_seed_unreadable");
      }
    }
  }

  start(): void {
    if (this.timer) return;
    void this.seed().catch(() => console.warn("[transcriber] purge_seed_failed"));
    this.timer = setInterval(() => void this.sweep(), this.options.intervalMs ?? 60_000);
    this.timer.unref?.();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One pass over every tracked address; returns how many purges were attempted and confirmed. */
  async sweep(): Promise<{ attempted: number; gone: number }> {
    if (this.running) return { attempted: 0, gone: 0 };
    this.running = true;
    let attempted = 0;
    let gone = 0;
    try {
      const now = (this.options.now ?? Date.now)();
      for (const address of [...this.addresses]) {
        let purging: NonNullable<TranscriberIndexEntries["purging"]>;
        try {
          purging = (await this.index.entries(address)).purging ?? {};
        } catch {
          continue; // Keep the address; the next pass reads it again.
        }
        for (const [id, state] of Object.entries(purging)) {
          if (state.nextAt > now) continue;
          attempted++;
          const outcome = await purgeMeeting(this.api, address, id, { delaysMs: [0] });
          try {
            if (outcome === "failed") {
              const attempts = state.attempts + 1;
              await this.index.notePurgeAttempt(address, id, now + purgeBackoffMs(attempts));
              const line = `[transcriber] purge_retry attempts=${attempts} pending_since_ms=${now - state.since}`;
              if (attempts >= ESCALATE_AFTER_ATTEMPTS) console.error(line);
              else console.warn(line);
              continue;
            }
            await this.index.remove(address, id);
            gone++;
          } catch {
            console.warn("[transcriber] purge_index_write_failed");
          }
        }
        try {
          if ((await this.index.entries(address)).purging === undefined) this.addresses.delete(address);
        } catch {
          /* keep tracking */
        }
      }
    } finally {
      this.running = false;
    }
    return { attempted, gone };
  }
}
