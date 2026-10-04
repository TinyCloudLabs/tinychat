// AssemblyAI: the opt-in Upload audio engine (contracts C8, C9), with the
// user's own API key. The key lives in the user's encrypted TinyCloud secrets
// under the global name `ASSEMBLYAI_API_KEY` (the same pattern as Fireflies,
// connectorSecrets.ts).
//
// Flow: POST /v2/upload (raw bytes) → POST /v2/transcript → poll
// GET /v2/transcript/{id}, all straight from this device to
// api.assemblyai.com → (save in the user's space) → delete the transcript,
// which also deletes the uploaded audio at AssemblyAI. Browsers can't send
// that DELETE (AssemblyAI's CORS allows no DELETE), so the TinyChat backend
// forwards it once with the key in `X-AssemblyAI-Key`, never storing or
// logging it; the audio itself never passes through the backend.

import type { SessionStore } from "@tinyboilerplate/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import {
  deleteConnectorKey,
  getConnectorKey,
  isSecretsUnlocked,
  saveConnectorKey,
  unlockSecrets,
  type SecretLocation,
  type SecretsErr,
} from "./connectors/connectorSecrets";
import type { FirefliesSentence } from "./connectors/firefliesClient";
import { REAL_CLOCK, type CloudClock } from "./privateCloud";

export const ASSEMBLYAI_API_URL = "https://api.assemblyai.com";
export const ASSEMBLYAI_API_KEY_URL = "https://www.assemblyai.com/dashboard/api-keys";
export const ASSEMBLYAI_TERMS_URL = "https://www.assemblyai.com/legal/terms-of-service";

/** Global (unscoped) like Listen's source keys, so one key serves every app. */
export const ASSEMBLYAI_SECRET: SecretLocation = { secretName: "ASSEMBLYAI_API_KEY" };

/** Current docs: highest-accuracy model, falling back to Universal-2 for its other languages. */
export const ASSEMBLYAI_SPEECH_MODELS = ["universal-3-5-pro", "universal-2"] as const;

export type AssemblyAiErrorKind = "invalid-key" | "network" | "rate-limited" | "rejected" | "failed" | "not-found";

export class AssemblyAiError extends Error {
  readonly kind: AssemblyAiErrorKind;
  constructor(kind: AssemblyAiErrorKind, message: string) {
    super(message);
    this.name = "AssemblyAiError";
    this.kind = kind;
  }
}

export interface AssemblyAiUtterance {
  speaker: string;
  text: string;
  /** Milliseconds. */
  start: number;
  end: number;
}

export interface AssemblyAiSentence {
  text: string;
  start: number;
  end: number;
  speaker?: string | null;
}

export interface AssemblyAiTranscript {
  id: string;
  status: "queued" | "processing" | "completed" | "error";
  text?: string | null;
  utterances?: AssemblyAiUtterance[] | null;
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
  createTranscript(audioUrl: string, options: { speakerLabels: boolean }): Promise<AssemblyAiTranscript>;
  getTranscript(id: string): Promise<AssemblyAiTranscript>;
  getSentences(id: string): Promise<AssemblyAiSentence[]>;
  /** Deletes the transcript and its uploaded audio. A transcript already gone counts as deleted. */
  deleteTranscript(id: string): Promise<void>;
}

async function errorFrom(response: Response): Promise<AssemblyAiError> {
  let message = `AssemblyAI answered HTTP ${response.status}`;
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === "string" && body.error.length > 0) message = body.error;
  } catch {
    // Not JSON: the status line says enough.
  }
  if (response.status === 401 || response.status === 403) return new AssemblyAiError("invalid-key", "AssemblyAI rejected this API key.");
  if (response.status === 404) return new AssemblyAiError("not-found", message);
  if (response.status === 429) return new AssemblyAiError("rate-limited", "AssemblyAI is rate limiting this key. Try again in a few minutes.");
  if (response.status >= 500) return new AssemblyAiError("network", message);
  return new AssemblyAiError("rejected", message);
}

/** The TinyChat backend's delete proxy (C9). */
export const ASSEMBLYAI_DELETE_PROXY_PATH = "/api/transcriber/assemblyai/transcripts";

export function createAssemblyAiClient(
  apiKey: string,
  options: {
    fetchImpl?: typeof fetch;
    createXhr?: () => XMLHttpRequest;
    baseUrl?: string;
    /** Where deleteTranscript goes; without it the client cannot delete. */
    backend?: { url: string; sessionStore: Pick<SessionStore, "getToken" | "isExpired"> };
  } = {},
): AssemblyAiClient {
  // Bound to the global: an unbound fetch called as a method is "Illegal invocation" in browsers.
  const fetchImpl = options.fetchImpl ?? fetch.bind(globalThis);
  const base = options.baseUrl ?? ASSEMBLYAI_API_URL;

  async function request(path: string, init: { method?: string; body?: string } = {}): Promise<Response> {
    let response: Response;
    try {
      response = await fetchImpl(`${base}${path}`, {
        method: init.method ?? "GET",
        // The raw key, no "Bearer": AssemblyAI's documented header.
        headers: { authorization: apiKey, ...(init.body === undefined ? {} : { "content-type": "application/json" }) },
        ...(init.body === undefined ? {} : { body: init.body }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new AssemblyAiError("network", "Could not reach AssemblyAI.");
    }
    if (!response.ok) throw await errorFrom(response);
    return response;
  }

  async function transcript(response: Response): Promise<AssemblyAiTranscript> {
    const body = (await response.json().catch(() => null)) as AssemblyAiTranscript | null;
    if (!body || typeof body.id !== "string" || typeof body.status !== "string") {
      throw new AssemblyAiError("failed", "AssemblyAI returned an unexpected transcript.");
    }
    return body;
  }

  return {
    async validateKey() {
      await request("/v2/transcript?limit=1");
    },

    upload(file, uploadOptions = {}) {
      return new Promise((resolve, reject) => {
        const xhr = options.createXhr?.() ?? new XMLHttpRequest();
        const signal = uploadOptions.signal;
        const onAbort = () => xhr.abort();
        const done = () => signal?.removeEventListener("abort", onAbort);
        xhr.open("POST", `${base}/v2/upload`);
        xhr.setRequestHeader("authorization", apiKey);
        xhr.setRequestHeader("content-type", "application/octet-stream");
        xhr.upload.onprogress = (e) => uploadOptions.onProgress?.(e.loaded, e.lengthComputable ? e.total : file.size);
        xhr.onload = () => {
          done();
          if (xhr.status >= 200 && xhr.status < 300) {
            let parsed: unknown = null;
            try {
              parsed = JSON.parse(xhr.responseText);
            } catch {
              // Rejected below.
            }
            const uploadUrl = parsed && typeof parsed === "object" && "upload_url" in parsed ? parsed.upload_url : null;
            if (typeof uploadUrl === "string") resolve(uploadUrl);
            else reject(new AssemblyAiError("failed", "AssemblyAI returned an unexpected upload response."));
            return;
          }
          void errorFrom(new Response(xhr.responseText || null, { status: xhr.status })).then(reject);
        };
        xhr.onerror = () => {
          done();
          reject(new AssemblyAiError("network", "The upload to AssemblyAI failed."));
        };
        xhr.onabort = () => {
          done();
          reject(new AssemblyAiError("failed", "The upload was cancelled."));
        };
        if (signal?.aborted) {
          reject(new AssemblyAiError("failed", "The upload was cancelled."));
          return;
        }
        signal?.addEventListener("abort", onAbort);
        xhr.send(file);
      });
    },

    async createTranscript(audioUrl, { speakerLabels }) {
      const response = await request("/v2/transcript", {
        method: "POST",
        body: JSON.stringify({
          audio_url: audioUrl,
          speech_models: ASSEMBLYAI_SPEECH_MODELS,
          language_detection: true,
          speaker_labels: speakerLabels,
        }),
      });
      return transcript(response);
    },

    async getTranscript(id) {
      return transcript(await request(`/v2/transcript/${encodeURIComponent(id)}`));
    },

    async getSentences(id) {
      const response = await request(`/v2/transcript/${encodeURIComponent(id)}/sentences`);
      const body = (await response.json().catch(() => null)) as { sentences?: unknown } | null;
      if (!body || !Array.isArray(body.sentences)) throw new AssemblyAiError("failed", "AssemblyAI returned unexpected sentences.");
      return body.sentences as AssemblyAiSentence[];
    },

    async deleteTranscript(id) {
      const backend = options.backend;
      if (backend === undefined) throw new AssemblyAiError("failed", "Deleting at AssemblyAI needs TinyChat's server.");
      const token = backend.sessionStore.getToken();
      if (!token || backend.sessionStore.isExpired()) {
        throw new AssemblyAiError("rejected", "Your session expired. Sign in again, then retry deleting.");
      }
      let response: Response;
      try {
        response = await fetchImpl(`${backend.url}${ASSEMBLYAI_DELETE_PROXY_PATH}/${encodeURIComponent(id)}`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${token}`, "X-Requested-With": "XMLHttpRequest", "X-AssemblyAI-Key": apiKey },
          signal: AbortSignal.timeout(30_000),
        });
      } catch {
        throw new AssemblyAiError("network", "Could not reach TinyChat's server to delete the transcript at AssemblyAI.");
      }
      // 404: AssemblyAI no longer has it — already deleted.
      if (response.ok || response.status === 404) return;
      let code: unknown = null;
      try {
        const body: unknown = await response.json();
        const error = body && typeof body === "object" && "error" in body ? body.error : null;
        code = error && typeof error === "object" && "code" in error ? error.code : error;
      } catch {
        // Classified by status alone.
      }
      if (response.status === 422 || code === "assemblyai_key_rejected") throw new AssemblyAiError("invalid-key", "AssemblyAI rejected the key.");
      if (response.status === 429) throw new AssemblyAiError("rate-limited", "AssemblyAI is rate limiting this key. Try again in a few minutes.");
      if (response.status === 401) throw new AssemblyAiError("rejected", "Your session expired. Sign in again, then retry deleting.");
      if (response.status >= 500) throw new AssemblyAiError("network", "AssemblyAI couldn't be reached to delete the transcript.");
      throw new AssemblyAiError("rejected", `Deleting the transcript at AssemblyAI failed (HTTP ${response.status}).`);
    },
  };
}

// ── TinyCloud's AssemblyAI account (C10) ───────────────────────────────

/** Whose AssemblyAI account transcribes: TinyCloud's (through Exo's server, the default) or the user's own key. */
export type AssemblyAiKeyMode = "hosted" | "own";

export const ASSEMBLYAI_KEY_MODE_STORAGE_KEY = "exo.transcriber.assemblyaiKeyMode";

export function readAssemblyAiKeyMode(): AssemblyAiKeyMode {
  try {
    return globalThis.localStorage?.getItem(ASSEMBLYAI_KEY_MODE_STORAGE_KEY) === "own" ? "own" : "hosted";
  } catch {
    return "hosted";
  }
}

export function writeAssemblyAiKeyMode(mode: AssemblyAiKeyMode): void {
  try {
    globalThis.localStorage?.setItem(ASSEMBLYAI_KEY_MODE_STORAGE_KEY, mode);
  } catch {
    // Best-effort preference.
  }
}

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
  if (response.status === 401) return new AssemblyAiError("rejected", "Your session expired. Sign in again, then retry.");
  if (response.status === 404) return new AssemblyAiError("not-found", "AssemblyAI no longer has this transcript.");
  if (code === "assemblyai_quota_exceeded") {
    return new AssemblyAiError("rate-limited", "You've reached today's limit for TinyCloud's AssemblyAI account. Try again tomorrow, or use your own API key.");
  }
  if (code === "assemblyai_busy" || response.status === 429) {
    return new AssemblyAiError("rate-limited", "TinyCloud's AssemblyAI account is busy, or another upload of yours is still running. Try again in a few minutes.");
  }
  if (response.status === 413 || code === "recording_too_large") {
    return new AssemblyAiError("rejected", "This file is larger than TinyCloud's AssemblyAI account takes (about 120 MB).");
  }
  if (response.status === 415 || code === "unsupported_audio") {
    return new AssemblyAiError("rejected", "TinyCloud's AssemblyAI account takes MP3, WAV, OGG, M4A/MP4, WebM or FLAC audio.");
  }
  if (response.status === 410) return new AssemblyAiError("failed", "The upload expired before it finished. Retry uploads the file again.");
  if (code === "assemblyai_hosted_unavailable") {
    return new AssemblyAiError("failed", "TinyCloud's AssemblyAI account isn't available right now. Try again later, or use your own API key.");
  }
  if (response.status >= 500) return new AssemblyAiError("network", "AssemblyAI couldn't be reached through Exo's server.");
  return new AssemblyAiError("rejected", `Exo's server refused the request (HTTP ${response.status}).`);
}

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
}): AssemblyAiClient & { capabilities(): Promise<HostedAssemblyAiCapabilities> } {
  const fetchImpl = config.fetchImpl ?? fetch.bind(globalThis);
  const sleep = config.sleep ?? REAL_CLOCK.sleep;
  const base = `${config.backendUrl}${HOSTED_ASSEMBLYAI_BASE_PATH}`;

  async function request(
    path: string,
    init: { method?: string; json?: unknown; body?: Blob; timeoutMs?: number; signal?: AbortSignal } = {},
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
    if (!response.ok) throw await hostedError(response);
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

    async createTranscript(uploadId, { speakerLabels }) {
      // The backend streams the whole file on to AssemblyAI before it answers.
      return transcript(
        await request("/hosted/transcripts", { method: "POST", json: { upload_id: uploadId, speaker_labels: speakerLabels }, timeoutMs: 15 * 60_000 }),
      );
    },

    async getTranscript(id) {
      return transcript(await request(`/hosted/transcripts/${encodeURIComponent(id)}`));
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
 * Polls a transcript to `completed`: 3 s, growing by half up to 15 s.
 * Network failures, rate limits and 5xx are ridden out for 10 minutes;
 * an `error` transcript or a rejected key ends it, and so does an aborted `signal`.
 */
export async function pollAssemblyAiTranscript(
  client: Pick<AssemblyAiClient, "getTranscript">,
  id: string,
  options: { clock?: CloudClock; onStatus?: (status: AssemblyAiTranscript["status"]) => void; signal?: AbortSignal } = {},
): Promise<AssemblyAiTranscript> {
  const clock = options.clock ?? REAL_CLOCK;
  let delayMs = 3_000;
  let failingSince: number | null = null;
  for (;;) {
    if (options.signal?.aborted) throw new AssemblyAiError("failed", "Stopped waiting for AssemblyAI.");
    try {
      const t = await client.getTranscript(id);
      if (options.signal?.aborted) throw new AssemblyAiError("failed", "Stopped waiting for AssemblyAI.");
      failingSince = null;
      if (t.status === "completed") return t;
      if (t.status === "error") {
        throw new AssemblyAiError("failed", t.error ? `AssemblyAI could not transcribe this file: ${t.error}` : "AssemblyAI could not transcribe this file.");
      }
      options.onStatus?.(t.status);
    } catch (err) {
      const transient = err instanceof AssemblyAiError && (err.kind === "network" || err.kind === "rate-limited");
      if (!transient) throw err;
      failingSince ??= clock.now();
      if (clock.now() - failingSince >= 10 * 60_000) {
        throw new AssemblyAiError("network", "Lost contact with AssemblyAI for 10 minutes. The transcript may still be running; Retry keeps waiting.");
      }
    }
    await clock.sleep(delayMs);
    delayMs = Math.min(15_000, Math.round(delayMs * 1.5));
  }
}

/** "A" → "Speaker A" (C7). */
export function assemblyAiSpeakerName(label: string): string {
  return `Speaker ${label}`;
}

/**
 * A finished transcript as the stored sentence shape: diarized utterances
 * become "Speaker A"/"Speaker B" turns; without speaker labels, AssemblyAI's
 * own sentence split (no speaker). Times are seconds.
 */
export function assemblyAiSentences(t: AssemblyAiTranscript, sentences: AssemblyAiSentence[] | null): FirefliesSentence[] {
  const rows =
    t.utterances && t.utterances.length > 0
      ? t.utterances.map((u) => ({ text: u.text, start: u.start, end: u.end, speaker: assemblyAiSpeakerName(u.speaker) }))
      : (sentences ?? []).map((s) => ({ text: s.text, start: s.start, end: s.end, speaker: null }));
  const out: FirefliesSentence[] = rows
    .map((r) => ({ ...r, text: r.text.trim() }))
    .filter((r) => r.text.length > 0 && Number.isFinite(r.start) && Number.isFinite(r.end))
    .map((r, index) => ({ index, speaker_name: r.speaker, text: r.text, start_time: r.start / 1000, end_time: r.end / 1000 }));
  // Neither utterances nor sentences, but text: one sentence rather than silently dropping speech.
  const text = t.text?.trim() ?? "";
  if (out.length === 0 && text.length > 0) {
    out.push({ index: 0, speaker_name: null, text, start_time: 0, end_time: t.audio_duration ?? 0 });
  }
  return out;
}

// ── The key, in the user's encrypted secrets ───────────────────────────

/** Not secret: whether this device last saw a saved key, so the vault need not be unlocked to show the engine. */
export const ASSEMBLYAI_KEY_HINT_STORAGE_KEY = "exo.transcriber.assemblyaiKeySaved";

export type AssemblyAiKeyStatus = "unknown" | "saved" | "none";

export function readAssemblyAiKeyHint(): AssemblyAiKeyStatus {
  try {
    const v = globalThis.localStorage?.getItem(ASSEMBLYAI_KEY_HINT_STORAGE_KEY);
    return v === "1" ? "saved" : v === "0" ? "none" : "unknown";
  } catch {
    return "unknown";
  }
}

function writeAssemblyAiKeyHint(saved: boolean): void {
  try {
    globalThis.localStorage?.setItem(ASSEMBLYAI_KEY_HINT_STORAGE_KEY, saved ? "1" : "0");
  } catch {
    // Best-effort: without it the engine shows as needing the vault.
  }
}

type SecretsTcw = Pick<TinyCloudWeb, "secrets"> & { ensureOwnedSpaceHosted?: TinyCloudWeb["ensureOwnedSpaceHosted"] };

export type KeyResult<T> = { ok: true; data: T } | { ok: false; message: string };

/** Opens the vault when it is locked (one wallet signature). */
async function ensureUnlocked(tcw: SecretsTcw): Promise<KeyResult<void>> {
  if (isSecretsUnlocked(tcw)) return { ok: true, data: undefined };
  const unlock = await unlockSecrets<SecretsErr>(tcw);
  return unlock.ok ? { ok: true, data: undefined } : { ok: false, message: unlock.error?.message ?? "Could not unlock your secrets." };
}

/** The saved key, or null when there is none. Unlocks the vault if needed. */
export async function readAssemblyAiKey(tcw: SecretsTcw): Promise<KeyResult<string | null>> {
  const unlocked = await ensureUnlocked(tcw);
  if (!unlocked.ok) return unlocked;
  const got = await getConnectorKey<SecretsErr>(tcw, ASSEMBLYAI_SECRET);
  if (!got.ok) {
    if (got.error?.code === "KEY_NOT_FOUND") {
      writeAssemblyAiKeyHint(false);
      return { ok: true, data: null };
    }
    return { ok: false, message: got.error?.message ?? "Could not read your AssemblyAI key." };
  }
  writeAssemblyAiKeyHint(got.data.length > 0);
  return { ok: true, data: got.data.length > 0 ? got.data : null };
}

/** Saves an already validated key. Unlocks the vault if needed. */
export async function saveAssemblyAiKey(tcw: SecretsTcw, key: string): Promise<KeyResult<void>> {
  const unlocked = await ensureUnlocked(tcw);
  if (!unlocked.ok) return unlocked;
  const saved = await saveConnectorKey<SecretsErr>(tcw, ASSEMBLYAI_SECRET, key);
  if (!saved.ok) return { ok: false, message: saved.error?.message ?? "Could not save your AssemblyAI key." };
  writeAssemblyAiKeyHint(true);
  return { ok: true, data: undefined };
}

export async function removeAssemblyAiKey(tcw: SecretsTcw): Promise<KeyResult<void>> {
  const unlocked = await ensureUnlocked(tcw);
  if (!unlocked.ok) return unlocked;
  const removed = await deleteConnectorKey<SecretsErr>(tcw, ASSEMBLYAI_SECRET);
  if (!removed.ok && removed.error?.code !== "KEY_NOT_FOUND") {
    return { ok: false, message: removed.error?.message ?? "Could not remove your AssemblyAI key." };
  }
  writeAssemblyAiKeyHint(false);
  return { ok: true, data: undefined };
}
