// The last Google Meet run's sync log, kept per account across page reloads so
// QA (and a bug report) can read a run after the page that ran it is gone.
//
// COUNTERS, STEP NAMES AND ERROR KINDS ONLY: what is stored is the output of
// `GmeetSyncLogRecorder.build`, which copies through an allow-list (see
// gmeetSyncLog.ts). No token, title, participant or transcript text reaches it.
//
// ONE ACCOUNT, ONE KEY (TC-1376): the key carries the account DID and the stored
// payload repeats it. A read that finds another account's payload under this key
// returns nothing, and a run is only ever persisted for the `tcw` it ran on.
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { getGmeetRunLog, onGmeetRunLog, type GmeetRunLogEvent } from "./gmeetSync";
import type { GmeetSyncLog } from "./gmeetSyncLog";

export const gmeetSyncLogStorageKey = (accountDid: string): string => `exo-gmeet-sync-log-v1:${accountDid}`;

/** Live runs persist at most this often; a run's start, its checkpoints and its end persist at once. */
const PERSIST_THROTTLE_MS = 2_000;

function defaultStorage(): Storage | undefined {
  try { return typeof localStorage === "undefined" ? undefined : localStorage; } catch { return undefined; }
}

export function readStoredGmeetSyncLog(accountDid: string | null | undefined, storage: Storage | undefined = defaultStorage()): GmeetSyncLog | null {
  if (!accountDid || !storage) return null;
  try {
    const parsed: unknown = JSON.parse(storage.getItem(gmeetSyncLogStorageKey(accountDid)) ?? "null");
    if (typeof parsed !== "object" || parsed === null || !("accountDid" in parsed) || !("log" in parsed)) return null;
    const { accountDid: owner, log } = parsed;
    if (owner !== accountDid || typeof log !== "object" || log === null || !("timeline" in log) || !Array.isArray(log.timeline)) return null;
    // Written by writeStoredGmeetSyncLog from the recorder's allow-listed output; the checks above only guard the owner and shape.
    const stored = log as GmeetSyncLog;
    return stored;
  } catch { return null; }
}

export function writeStoredGmeetSyncLog(accountDid: string, log: GmeetSyncLog, storage: Storage | undefined = defaultStorage()): void {
  if (!accountDid || !storage) return;
  try { storage.setItem(gmeetSyncLogStorageKey(accountDid), JSON.stringify({ accountDid, log })); }
  catch { /* A full or blocked store only loses the persisted copy. */ }
}

/** What "Copy sync log" copies: this page load's latest run for the account, else the persisted one. */
export function loadGmeetSyncLog(tcw: TinyCloudWeb, build?: string | null, storage?: Storage): GmeetSyncLog | null {
  return getGmeetRunLog(tcw, build) ?? readStoredGmeetSyncLog(tcw.did, storage);
}

/**
 * Persist every run's log for `tcw`'s account while the shell is mounted. Runs of
 * another `tcw` are ignored. Returns the stop function.
 */
export function startPersistingGmeetRunLog(
  tcw: TinyCloudWeb,
  options: { storage?: Storage; build?: () => string | null; throttleMs?: number } = {},
): () => void {
  const throttleMs = options.throttleMs ?? PERSIST_THROTTLE_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let latest: GmeetRunLogEvent | null = null;
  const flush = () => {
    clearTimeout(timer);
    timer = undefined;
    const event = latest;
    const accountDid = tcw.did;
    if (event === null || !accountDid) return;
    latest = null;
    writeStoredGmeetSyncLog(accountDid, event.recorder.build({ generatedAt: new Date(), build: options.build?.() ?? null }), options.storage);
  };
  const off = onGmeetRunLog((event) => {
    if (event.tcw !== tcw) return;
    latest = event;
    if (event.final || event.urgent) flush();
    else timer ??= setTimeout(flush, throttleMs);
  });
  return () => {
    off();
    flush();
  };
}
