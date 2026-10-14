// Hosted AssemblyAI: authenticated Exo server proxy; the server keeps the key.
import type { SessionStore } from "@tinyboilerplate/client";
import type { FirefliesSentence } from "./connectors/firefliesClient";
import {
  cloudStatusIntervalMs,
  jitteredCloudIntervalMs,
  DEFAULT_CLOUD_POLLING,
  jitteredRateLimitWaitMs,
  parseRateLimitWaitSeconds,
  REAL_CLOCK,
  type CloudClock,
} from "./privateCloud";
import { splitLongTimedSegment } from "./voiceNotes/timedSegments";

export type AssemblyAiErrorKind = "invalid-key" | "network" | "rate-limited" | "rejected" | "failed" | "not-found" | "needs-reconciliation";

export class AssemblyAiError extends Error {
  readonly kind: AssemblyAiErrorKind;
  constructor(
    kind: AssemblyAiErrorKind,
    message: string,
    readonly uploadEnded = false,
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = "AssemblyAiError";
    this.kind = kind;
  }
}
export interface AssemblyAiUtterance {
  speaker: string | null;
  text: string;
  /** Milliseconds. */
  start: number;
  end: number;
  channel?: 0 | 1 | null;
}

export interface AssemblyAiSentence {
  text: string;
  start: number;
  end: number;
  speaker?: string | null;
  channel?: 0 | 1 | null;
  words?: { start: number; end: number; text: string }[];
}

export interface AssemblyAiTranscript {
  id: string;
  status: "queued" | "processing" | "completed" | "error";
  text?: string | null;
  utterances?: AssemblyAiUtterance[] | null;
  audio_channels?: number | null;
  /** Seconds. */
  audio_duration?: number | null;
  language_code?: string | null;
  speech_model_used?: string | null;
  speaker_labels?: boolean | null;
  error?: string | null;
}

export interface AssemblyAiClient {
  /** Resolves when AssemblyAI accepts the key; `invalid-key` when it doesn't. */
  validateKey(): Promise<void>;
  /** Uploads the raw bytes; returns the private `upload_url` a transcript reads. */
  upload(
    file: Blob,
    options?: { onProgress?: (sent: number, total: number) => void; signal?: AbortSignal; /** Canonical C1 type, when known. */ contentType?: string },
  ): Promise<string>;
  /**
   * Starts the transcript of an uploaded file (`upload`'s answer). Safe to call again with the same
   * reference after a reload: TinyCloud's account re-joins its submission instead of starting another.
   */
  createTranscript(uploadRef: string, options: { speakerLabels: boolean; multichannel?: boolean; signal?: AbortSignal }): Promise<AssemblyAiTranscript>;
  getTranscript(id: string, signal?: AbortSignal): Promise<AssemblyAiTranscript>;
  getSentences(id: string): Promise<AssemblyAiSentence[]>;
  /** Deletes the transcript and its uploaded audio. A transcript already gone counts as deleted. */
  deleteTranscript(id: string): Promise<void>;
  /** Hosted only: abandon an upload, or wait for its handle and delete the transcript. */
  deleteUpload?(uploadRef: string, options?: { signal?: AbortSignal; uploadSubmitting?: boolean; onSubmitting?: () => void; onSubmitted?: (id: string) => void }): Promise<void>;
}

// ── TinyCloud's AssemblyAI account (C10) ───────────────────────────────

/** Legacy pending uploads may still record their original account mode. New uploads use hosted only. */
export type AssemblyAiKeyMode = "hosted" | "own";

export const HOSTED_ASSEMBLYAI_BASE_PATH = "/api/transcriber/assemblyai";

export interface HostedAssemblyAiCapabilities {
  hosted: boolean;
  max_bytes: number;
  part_size: number;
  content_types: string[];
  daily_bytes_remaining: number | null;
}

/** The backend's error envelope: `{ error: "code", message }` or `{ error: { code, message } }`. */
async function hostedErrorCode(response: Response): Promise<string | null> {
  try {
    const body: unknown = await response.json();
    if (!body || typeof body !== "object" || !("error" in body)) return null;
    const error = body.error;
    if (typeof error === "string") return error;
    return error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : null;
  } catch {
    return null;
  }
}

/** A non-2xx answer from the hosted routes as the kinds the runner already handles. */
async function hostedError(response: Response): Promise<AssemblyAiError> {
  const code = await hostedErrorCode(response);
  const retryAfterSeconds = parseRateLimitWaitSeconds(response.headers);
  const retryAfterMs = retryAfterSeconds === null ? null : retryAfterSeconds * 1000;
  if (response.status === 401) return new AssemblyAiError("rejected", "Your session expired. Sign in again, then retry.");
  if (response.status === 404) return new AssemblyAiError("not-found", "AssemblyAI no longer has this transcript.");
  if (code === "assemblyai_needs_reconciliation") return new AssemblyAiError("needs-reconciliation", "Powerful couldn't confirm an earlier attempt. Exo is checking with AssemblyAI.");
  if (code === "assemblyai_quota_exceeded") {
    const hours = retryAfterSeconds === null ? null : Math.max(1, Math.ceil(retryAfterSeconds / 3600));
    return new AssemblyAiError(
      "rate-limited",
      `Today's Powerful allowance is used. Try again ${hours ? `in about ${hours} hours` : "tomorrow"}.`,
      false,
      retryAfterMs,
    );
  }
  if (code === "assemblyai_busy" || response.status === 429) {
    return new AssemblyAiError("rate-limited", "Powerful is busy right now. Try again in a few minutes.", false, retryAfterMs);
  }
  if (response.status === 413 || code === "recording_too_large") {
    return new AssemblyAiError("rejected", "This recording is too large for Powerful (120 MB maximum).");
  }
  if (response.status === 415 || code === "unsupported_audio") {
    return new AssemblyAiError("rejected", "TinyCloud's AssemblyAI account takes MP3, WAV, OGG, M4A/MP4, WebM or FLAC audio.");
  }
  if (response.status === 410) return new AssemblyAiError("failed", "The upload expired before it finished. Retry uploads the file again.");
  if (code === "assemblyai_hosted_unavailable") {
    return new AssemblyAiError("failed", "Powerful isn't available right now. Try again later.");
  }
  if (response.status >= 500) return new AssemblyAiError("network", "AssemblyAI couldn't finish this transcript. Try again.");
  return new AssemblyAiError("rejected", `Exo's server refused the request (HTTP ${response.status}).`);
}

interface HostedSubmission {
  status: "missing" | "receiving" | "submitting" | "submitted" | "failed" | "needs_reconciliation" | "unresolved" | "deleted";
  id?: string;
  upload_id?: string;
  error?: { code?: string } | null;
}

async function submission(response: Response): Promise<HostedSubmission> {
  const body = (await response.json().catch(() => null)) as HostedSubmission | null;
  if (!body || typeof body.status !== "string") throw new AssemblyAiError("failed", "Exo's server returned an unexpected upload state.");
  return body;
}

/** How often the submission is checked, and for how long (the backend gives up after 15 minutes). */
const SUBMIT_POLL_MS = 2_000;
const SUBMIT_DEADLINE_MS = 16 * 60_000;

/** Retries of one part after a network failure or a 5xx; a re-PUT of the same part is idempotent. */
const PART_RETRY_DELAYS_MS = [1_000, 3_000];

/**
 * TinyCloud's AssemblyAI account, through the TinyChat backend (C10): the
 * same AssemblyAiClient as the user's own key, so the runner treats both
 * alike. The audio reaches the backend in parts of at most 1 MiB (its ingress
 * limit); the transcript is addressed by an opaque, account-bound handle.
 */
export function createHostedAssemblyAiClient(config: {
  backendUrl: string;
  sessionStore: Pick<SessionStore, "getToken" | "isExpired">;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}): Omit<AssemblyAiClient, "createTranscript"> & {
  createTranscript(uploadId: string, options: { speakerLabels: boolean; multichannel?: boolean; signal?: AbortSignal; sourceId?: string }): Promise<AssemblyAiTranscript>;
  capabilities(): Promise<HostedAssemblyAiCapabilities>;
  createUpload(size: number, contentType: string, sourceId?: string): Promise<{ uploadId: string; partSize: number; status?: HostedSubmission["status"]; id?: string }>;
  lookupJob(sourceId: string): Promise<HostedSubmission>;
  putPart(uploadId: string, index: number, bytes: Uint8Array): Promise<void>;
  uploadState(uploadId: string): Promise<HostedSubmission>;
} {
  const fetchImpl = config.fetchImpl ?? fetch.bind(globalThis);
  const sleep = config.sleep ?? REAL_CLOCK.sleep;
  const base = `${config.backendUrl}${HOSTED_ASSEMBLYAI_BASE_PATH}`;

  async function request(
    path: string,
    init: { method?: string; json?: unknown; body?: Blob; timeoutMs?: number; signal?: AbortSignal; uploadState?: boolean; allowConflict?: boolean } = {},
  ): Promise<Response> {
    const token = config.sessionStore.getToken();
    if (!token || config.sessionStore.isExpired()) throw new AssemblyAiError("rejected", "Your session expired. Sign in again, then retry.");
    const timeout = AbortSignal.timeout(init.timeoutMs ?? 30_000);
    const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await fetchImpl(`${base}${path}`, {
        method: init.method ?? "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          "X-Requested-With": "XMLHttpRequest",
          ...(init.json !== undefined ? { "Content-Type": "application/json" } : {}),
          ...(init.body !== undefined ? { "Content-Type": "application/octet-stream" } : {}),
        },
        ...(init.json !== undefined ? { body: JSON.stringify(init.json) } : {}),
        ...(init.body !== undefined ? { body: init.body } : {}),
        signal,
      });
    } catch {
      if (init.signal?.aborted) throw new AssemblyAiError("failed", "The upload was cancelled.");
      throw new AssemblyAiError("network", "Could not reach Exo's server.");
    }
    if (!response.ok && !(init.allowConflict && response.status === 409)) {
      const error = await hostedError(response);
      if (init.uploadState && (response.status === 404 || response.status === 410)) {
        throw new AssemblyAiError(error.kind, error.message, true);
      }
      throw error;
    }
    return response;
  }

  async function transcript(response: Response): Promise<AssemblyAiTranscript> {
    const body = (await response.json().catch(() => null)) as AssemblyAiTranscript | null;
    if (!body || typeof body.id !== "string" || typeof body.status !== "string") {
      throw new AssemblyAiError("failed", "Exo's server returned an unexpected transcript.");
    }
    return body;
  }

  return {
    async capabilities() {
      return (await request("/capabilities").then((r) => r.json())) as HostedAssemblyAiCapabilities;
    },

    async createUpload(size, contentType, sourceId) {
      const created = (await request("/hosted/uploads", { method: "POST", json: { byte_size: size, content_type: contentType, ...(sourceId ? { source_id: sourceId } : {}) } }).then((r) => r.json())) as { upload_id?: unknown; part_size?: unknown; status?: HostedSubmission["status"]; id?: string };
      if (typeof created.upload_id !== "string" || typeof created.part_size !== "number" || created.part_size <= 0)
        throw new AssemblyAiError("failed", "Exo's server returned an unexpected upload.");
      if (created.status === "needs_reconciliation")
        throw new AssemblyAiError("needs-reconciliation", "Powerful couldn't confirm an earlier attempt. Exo is checking with AssemblyAI.");
      return { uploadId: created.upload_id, partSize: created.part_size, status: created.status, id: created.id };
    },

    async lookupJob(sourceId) {
      return submission(await request(`/hosted/jobs/${encodeURIComponent(sourceId)}`));
    },

    async putPart(uploadId, index, bytes) {
      await request(`/hosted/uploads/${encodeURIComponent(uploadId)}/parts/${index}`, {
        method: "PUT", body: new Blob([bytes as Uint8Array<ArrayBuffer>]), timeoutMs: 60_000, uploadState: true,
      });
    },

    async uploadState(uploadId) {
      return submission(await request(`/hosted/uploads/${encodeURIComponent(uploadId)}`, { uploadState: true }));
    },

    async validateKey() {
      // Nothing to validate: the key is TinyCloud's and never reaches this device.
    },

    async upload(file, options = {}) {
      const created = (await request("/hosted/uploads", {
        method: "POST",
        json: { byte_size: file.size, content_type: options.contentType ?? file.type },
        signal: options.signal,
      }).then((r) => r.json())) as { upload_id?: unknown; part_size?: unknown };
      if (typeof created.upload_id !== "string" || typeof created.part_size !== "number" || created.part_size <= 0) {
        throw new AssemblyAiError("failed", "Exo's server returned an unexpected upload.");
      }
      const uploadId = created.upload_id;
      const partSize = Math.min(created.part_size, 1024 * 1024);
      const parts = Math.max(1, Math.ceil(file.size / partSize));
      options.onProgress?.(0, file.size);
      try {
        for (let index = 0; index < parts; index++) {
          const part = file.slice(index * partSize, Math.min(file.size, (index + 1) * partSize));
          for (let attempt = 0; ; attempt++) {
            try {
              await request(`/hosted/uploads/${encodeURIComponent(uploadId)}/parts/${index}`, {
                method: "PUT",
                body: part,
                timeoutMs: 60_000,
                signal: options.signal,
              });
              break;
            } catch (err) {
              const transient = err instanceof AssemblyAiError && err.kind === "network";
              if (!transient || attempt >= PART_RETRY_DELAYS_MS.length || options.signal?.aborted) throw err;
              await sleep(PART_RETRY_DELAYS_MS[attempt]!);
            }
          }
          options.onProgress?.(Math.min(file.size, (index + 1) * partSize), file.size);
        }
      } catch (err) {
        // Free the account's one upload slot (and its share of the daily allowance) at once, not in an hour.
        void request(`/hosted/uploads/${encodeURIComponent(uploadId)}`, { method: "DELETE" }).catch(() => {});
        throw err;
      }
      return uploadId;
    },

    async createTranscript(uploadId, { speakerLabels, multichannel = false, signal, sourceId }: { speakerLabels: boolean; multichannel?: boolean; signal?: AbortSignal; sourceId?: string }) {
      // The backend sends the file on to AssemblyAI in the background: 202 with the submission's state,
      // then its state by upload id until it has the transcript's handle. A replay re-joins it.
      const path = `/hosted/uploads/${encodeURIComponent(uploadId)}`;
      let state: HostedSubmission;
      try {
        state = await submission(
          await request("/hosted/transcripts", { method: "POST", json: { upload_id: uploadId, speaker_labels: speakerLabels, multichannel, ...(sourceId ? { source_id: sourceId } : {}) }, signal }),
        );
      } catch (err) {
        if (!(err instanceof AssemblyAiError) || (err.kind !== "not-found" && err.kind !== "failed")) throw err;
        state = await submission(await request(path, { signal, uploadState: true }));
      }
      const deadline = Date.now() + SUBMIT_DEADLINE_MS;
      while (state.status === "submitting" || state.status === "receiving") {
        if (Date.now() > deadline) throw new AssemblyAiError("network", "Exo's server is still sending the file to AssemblyAI. Retry keeps waiting.");
        await sleep(SUBMIT_POLL_MS);
        if (signal?.aborted) throw new AssemblyAiError("failed", "The upload was cancelled.");
        state = await submission(await request(path, { signal, uploadState: true }));
      }
      if (state.status === "submitted" && typeof state.id === "string") return { id: state.id, status: "queued" };
      if (state.status !== "failed") throw new AssemblyAiError("network", "Exo's server returned an unexpected upload state. Retry keeps waiting.");
      const code = state.error?.code;
      throw code === "assemblyai_rate_limited"
        ? new AssemblyAiError("rate-limited", "AssemblyAI is busy for TinyCloud's account. Retry uploads the file again in a few minutes.", true)
        : new AssemblyAiError("failed", "Exo's server couldn't send the file to AssemblyAI. Retry uploads it again.", true);
    },

    async deleteUpload(uploadId, { signal, uploadSubmitting = false, onSubmitting, onSubmitted } = {}) {
      const path = `/hosted/uploads/${encodeURIComponent(uploadId)}`;
      const deadline = Date.now() + SUBMIT_DEADLINE_MS;
      let missingChecks = 0;
      for (;;) {
        let state: HostedSubmission;
        try {
          state = await submission(await request(path, { signal, uploadState: true }));
        } catch (err) {
          if (err instanceof AssemblyAiError && err.uploadEnded) {
            if (err.kind !== "not-found") return;
            // A missing upload can be a transient settlement gap on an older backend.
            if (missingChecks++ < 2) {
              await sleep(SUBMIT_POLL_MS);
              continue;
            }
            if (!uploadSubmitting) return;
            throw new AssemblyAiError("not-found", "The submitted upload's outcome is unavailable. Retry deleting later.", true);
          }
          throw err;
        }
        if (state.status === "failed") return;
        if (state.status === "submitted" && typeof state.id === "string") {
          onSubmitted?.(state.id);
          await this.deleteTranscript(state.id);
          return;
        }
        if (state.status !== "receiving" && state.status !== "submitting") {
          throw new AssemblyAiError("network", "Exo's server returned an unexpected upload state. Retry deleting keeps waiting.");
        }
        if (state.status === "submitting") onSubmitting?.();
        // A claim may win between GET and DELETE. A 409 keeps the reference until its handle arrives.
        const deleted = await request(path, { method: "DELETE", signal, allowConflict: true });
        if (deleted.status !== 409) return;
        uploadSubmitting = true;
        onSubmitting?.();
        if (Date.now() > deadline) throw new AssemblyAiError("network", "Exo's server is still sending the file. Retry deleting keeps waiting.");
        await sleep(SUBMIT_POLL_MS);
      }
    },

    async getTranscript(id, signal) {
      return transcript(await request(`/hosted/transcripts/${encodeURIComponent(id)}`, { signal }));
    },

    async getSentences(id) {
      const body = (await request(`/hosted/transcripts/${encodeURIComponent(id)}/sentences`).then((r) => r.json().catch(() => null))) as {
        sentences?: unknown;
      } | null;
      if (!body || !Array.isArray(body.sentences)) throw new AssemblyAiError("failed", "Exo's server returned unexpected sentences.");
      return body.sentences as AssemblyAiSentence[];
    },

    async deleteTranscript(id) {
      try {
        await request(`/hosted/transcripts/${encodeURIComponent(id)}`, { method: "DELETE" });
      } catch (err) {
        if (err instanceof AssemblyAiError && err.kind === "not-found") return;
        throw err;
      }
    },
  };
}

/**
 * Poll a hosted transcript with the same cadence and bounded failure policy as PTX.
 * A caller's signal cancels only this ordinary request/wait loop.
 */
export async function pollAssemblyAiTranscript(
  client: Pick<AssemblyAiClient, "getTranscript">,
  id: string,
  options: {
    clock?: CloudClock;
    onStatus?: (status: AssemblyAiTranscript["status"]) => void;
    signal?: AbortSignal;
    guard?: () => void;
    durationSeconds?: number | null;
  } = {},
): Promise<AssemblyAiTranscript> {
  const clock = options.clock ?? REAL_CLOCK;
  const polling = DEFAULT_CLOUD_POLLING;
  const startedAt = clock.now();
  let durationSeconds = options.durationSeconds ?? null;
  let failingSince: number | null = null;
  let throttledMs = 0;
  let throttledAtFailure = 0;
  const cancelled = () => new AssemblyAiError("failed", "Stopped waiting for AssemblyAI.");
  const sleepWithSignal = async (ms: number): Promise<void> => {
    const signal = options.signal;
    if (signal === undefined) {
      await clock.sleep(ms);
      return;
    }
    if (signal.aborted) throw cancelled();
    let removeAbort = (): void => {};
    try {
      await Promise.race([
        clock.sleep(ms),
        new Promise<never>((_, reject) => {
          const onAbort = (): void => reject(cancelled());
          signal.addEventListener("abort", onAbort, { once: true });
          removeAbort = () => signal.removeEventListener("abort", onAbort);
          if (signal.aborted) onAbort();
        }),
      ]);
    } finally {
      removeAbort();
    }
  };
  const waitThrottled = async (ms: number): Promise<void> => {
    const before = clock.now();
    try {
      await sleepWithSignal(ms);
    } finally {
      throttledMs += Math.max(0, clock.now() - before);
    }
  };

  for (;;) {
    if (options.signal?.aborted) throw cancelled();
    options.guard?.();
    try {
      const t = await client.getTranscript(id, options.signal);
      if (options.signal?.aborted) throw cancelled();
      options.guard?.();
      failingSince = null;
      throttledAtFailure = throttledMs;
      if (typeof t.audio_duration === "number" && Number.isFinite(t.audio_duration) && t.audio_duration > 0) {
        durationSeconds = t.audio_duration;
      }
      if (t.status === "completed") return t;
      if (t.status === "error") {
        throw new AssemblyAiError("failed", t.error ? `AssemblyAI could not transcribe this file: ${t.error}` : "AssemblyAI could not transcribe this file.");
      }
      options.onStatus?.(t.status);
    } catch (err) {
      if (options.signal?.aborted) throw cancelled();
      if (err instanceof AssemblyAiError && err.kind === "rate-limited") {
        await waitThrottled(jitteredRateLimitWaitMs(
          err.retryAfterMs === null ? null : err.retryAfterMs / 1000,
          polling.slowIntervalMs,
          clock.random,
        ));
        continue;
      }
      if (!(err instanceof AssemblyAiError) || err.kind !== "network") throw err;
      const now = clock.now();
      if (failingSince === null) {
        failingSince = now;
        throttledAtFailure = throttledMs;
      }
      const failingFor = Math.max(0, now - failingSince - (throttledMs - throttledAtFailure));
      if (failingFor >= polling.giveUpAfterMs) {
        throw new AssemblyAiError("network", "Lost contact with AssemblyAI. The transcript may still be running; Retry keeps waiting.");
      }
      const retryInterval = failingFor >= polling.slowAfterMs ? polling.slowIntervalMs : polling.intervalMs;
      await sleepWithSignal(Math.round(retryInterval * (0.8 + 0.4 * clock.random())));
      continue;
    }
    const elapsed = clock.now() - startedAt;
    const interval = cloudStatusIntervalMs(durationSeconds, elapsed, polling);
    await sleepWithSignal(elapsed < polling.fastPhaseMs ? interval : jitteredCloudIntervalMs(interval, clock.random));
  }
}

/** "A" → "Speaker A" (C7). */
export function assemblyAiSpeakerName(label: string): string {
  return `Speaker ${label}`;
}

/** Prefer AssemblyAI sentence and word ranges while retaining speaker and channel identity. */
export function assemblyAiSentences(t: AssemblyAiTranscript, sentences: AssemblyAiSentence[] | null,
  options: { stereo?: boolean } = {}): FirefliesSentence[] {
  const stereo = options.stereo ?? t.audio_channels === 2;
  const utterances = t.utterances ?? [];
  const bySpeaker = new Map<string, { rows: typeof utterances; maxEnd: number[] }>();
  if (stereo && sentences?.length) {
    for (const utterance of utterances) {
      for (const key of ["*", ...(utterance.speaker == null ? [] : [utterance.speaker])]) {
        const index = bySpeaker.get(key) ?? { rows: [], maxEnd: [] };
        index.rows.push(utterance);
        bySpeaker.set(key, index);
      }
    }
    for (const index of bySpeaker.values()) {
      index.rows.sort((a, b) => a.start - b.start);
      for (const row of index.rows) index.maxEnd.push(Math.max(row.end, index.maxEnd.at(-1) ?? -Infinity));
    }
  }
  const containingUtterance = (sentence: AssemblyAiSentence) => {
    const index = bySpeaker.get(sentence.speaker == null ? "*" : sentence.speaker);
    if (!index) return undefined;
    let lo = 0; let hi = index.rows.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (index.maxEnd[mid]! >= sentence.end) hi = mid;
      else lo = mid + 1;
    }
    const row = index.rows[lo];
    return row && row.start <= sentence.start ? row : undefined;
  };
  const channelOf = (label: string | null | undefined): 0 | 1 | undefined => {
    if (!stereo || !label) return undefined;
    const match = /^([12])(?:[A-Z])?$/.exec(label);
    return match ? (Number(match[1]) - 1) as 0 | 1 : undefined;
  };
  const rows: AssemblyAiSentence[] = sentences?.length ? sentences.map((s) => ({ ...s,
    speaker: s.speaker ?? null,
    channel: s.channel ?? (stereo ? containingUtterance(s)?.channel : undefined) ?? channelOf(s.speaker) }))
    : utterances.map((u) => ({ text: u.text, start: u.start, end: u.end,
      speaker: u.speaker, channel: u.channel ?? channelOf(u.speaker) }));
  const out: FirefliesSentence[] = rows
    .map((r) => ({ ...r, text: r.text.trim() }))
    .filter((r) => r.text.length > 0 && Number.isFinite(r.start) && Number.isFinite(r.end))
    .flatMap((r) => {
      const base = { start: r.start, end: r.end, text: r.text, speaker: r.speaker ?? null,
        channel: r.channel, timing: "engine" as const };
      const words = r.words;
      if (words?.length && words[0]!.start <= r.start + 1_000 && words.at(-1)!.end >= r.end - 1_000
        && r.end - r.start > 30_000) {
        const pieces: typeof base[] = [];
        for (const word of words) {
          const last = pieces.at(-1);
          if (last && word.end - last.start <= 30_000) { last.end = word.end; last.text += ` ${word.text}`; }
          else pieces.push({ ...base, start: word.start, end: word.end, text: word.text });
        }
        return pieces.flatMap((piece) => splitLongTimedSegment(piece, 30_000));
      }
      return splitLongTimedSegment(base, 30_000);
    })
    .sort((a, b) => a.start - b.start || a.end - b.end)
    .map((r, index) => ({ index, speaker_name: r.speaker ? assemblyAiSpeakerName(r.speaker) : null,
      ...(r.speaker ? { speaker_id: r.speaker } : {}), text: r.text, start_time: r.start / 1000,
      end_time: r.end / 1000, timing: r.timing,
      ...(r.channel === 0 || r.channel === 1 ? { channel: r.channel } : {}) }));
  // Neither utterances nor sentences, but text: one sentence rather than silently dropping speech.
  const text = t.text?.trim() ?? "";
  if (out.length === 0 && text.length > 0) {
    out.push(...splitLongTimedSegment({ start: 0, end: t.audio_duration ?? 0, text, timing: "coarse" as const }, 30)
      .map((r, index) => ({ index, speaker_name: null, text: r.text, start_time: r.start,
        end_time: r.end, timing: r.timing })));
  }
  return out;
}
