/**
 * End-to-end check for Exo private cloud transcription (plan §8 V4). Drives the public path the
 * clients use: capabilities → create → PUT the audio straight to the PTX origin with the
 * job-scoped capability → poll status → result → DELETE → the job is gone (404).
 *
 *   BACKEND_URL=https://api.tinycloud.chat BEARER=<session token> \
 *   PTX_ORIGIN=https://<app_id>-8080.<gateway> AUDIO=fixture.mp3 [DIARIZE=true] \
 *   bun backend/scripts/e2e-private-cloud-transcription.ts
 *
 * DIARIZE=true asks for speaker diarization (a mono mixdown) and requires a diarized result.
 * Output is ids, statuses, counts and correlation ids only — never the bearer, the capability or
 * transcript text.
 */
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

const UPLOAD_PATH_RE = /^\/uploads\/trn_[0-9A-HJKMNP-TV-Z]{26}$/;
const TERMINAL = new Set(["completed", "failed", "cancelled"]);
/** File extension → the create's (and the upload's) content type. */
const CONTENT_TYPES = {
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".opus": "audio/ogg",
  ".m4a": "audio/mp4",
  ".mp4": "audio/mp4",
  ".m4b": "audio/mp4",
  ".webm": "audio/webm",
  ".flac": "audio/flac",
} as const;

export interface PrivateCloudE2EOptions {
  backendUrl: string;
  bearer: string;
  /** The PTX origin the desktop has compiled in; the backend never supplies it. */
  ptxOrigin: string;
  audio: Uint8Array;
  contentType: (typeof CONTENT_TYPES)[keyof typeof CONTENT_TYPES];
  pollIntervalMs?: number;
  diarize?: boolean;
  timeoutMs?: number;
  log?: (line: string) => void;
}

export async function runPrivateCloudE2E(
  options: PrivateCloudE2EOptions,
): Promise<{ id: string; segments: number; speakers: number; diarized: boolean }> {
  const log = options.log ?? ((line: string) => console.log(line));
  const api = `${options.backendUrl.replace(/\/+$/, "")}/api/transcriber/private-cloud`;

  async function call(step: string, method: string, path: string, expected: number[], init: { headers?: Record<string, string>; body?: string } = {}) {
    const correlationId = randomUUID();
    const response = await fetch(`${api}${path}`, {
      method,
      redirect: "manual",
      headers: {
        Authorization: `Bearer ${options.bearer}`,
        "X-Requested-With": "XMLHttpRequest",
        "X-Correlation-Id": correlationId,
        ...init.headers,
      },
      ...(init.body === undefined ? {} : { body: init.body }),
    });
    const text = await response.text();
    const json = text ? (JSON.parse(text) as Record<string, any>) : null;
    if (!expected.includes(response.status)) {
      throw new Error(`${step}: HTTP ${response.status} code=${json?.error?.code ?? "-"} ref=${correlationId}`);
    }
    return { status: response.status, json };
  }

  const capabilities = await call("capabilities", "GET", "/capabilities", [200]);
  log(
    `capabilities max_bytes=${capabilities.json?.max_bytes} admission=${JSON.stringify(capabilities.json?.admission ?? null)}` +
      ` diarization=${JSON.stringify(capabilities.json?.diarization ?? null)}`,
  );

  const created = await call("create", "POST", "/transcriptions", [201], {
    headers: { "Content-Type": "application/json", "Idempotency-Key": randomUUID() },
    body: JSON.stringify({
      content_type: options.contentType,
      byte_size: options.audio.byteLength,
      sha256: createHash("sha256").update(options.audio).digest("hex"),
      language: "en",
      ...(options.diarize
        ? { channel_mode: "mixed", diarize: true }
        : { channel_mode: "separate", channel_labels: ["Speaker 1", "Speaker 2"] }),
    }),
  });
  const id = created.json!.id as string;
  const upload = created.json!.upload as { path: string; capability: string };
  if (!UPLOAD_PATH_RE.test(upload.path) || upload.path !== `/uploads/${id}`) {
    throw new Error("create: upload.path is not the relative /uploads/<id> path");
  }
  log(`created id=${id} status=${created.json!.status}`);

  const put = await fetch(`${options.ptxOrigin.replace(/\/+$/, "")}${upload.path}`, {
    method: "PUT",
    redirect: "manual",
    headers: { Authorization: `Bearer ${upload.capability}`, "Content-Type": options.contentType },
    body: options.audio,
  });
  await put.text();
  if (put.status !== 201) throw new Error(`upload: HTTP ${put.status}`);
  log(`uploaded bytes=${options.audio.byteLength}`);

  const deadline = Date.now() + (options.timeoutMs ?? 60 * 60_000);
  let status = "queued";
  while (!TERMINAL.has(status)) {
    if (Date.now() > deadline) throw new Error(`poll: still ${status} at the deadline`);
    await new Promise((resolve) => setTimeout(resolve, options.pollIntervalMs ?? 5_000));
    const job = await call("status", "GET", `/transcriptions/${id}`, [200]);
    if (job.json!.status !== status) log(`status ${status} → ${job.json!.status}`);
    status = job.json!.status;
    if (status === "failed") throw new Error(`job failed code=${job.json!.error?.code ?? "-"}`);
  }
  if (status !== "completed") throw new Error(`job ended ${status}`);

  const result = await call("result", "GET", `/transcriptions/${id}/result`, [200]);
  const segments = Array.isArray(result.json!.segments) ? result.json!.segments.length : 0;
  const speakers = Array.isArray(result.json!.speakers) ? result.json!.speakers.length : 0;
  const diarized = result.json!.diarized === true;
  log(`result segments=${segments} speakers=${speakers} diarized=${diarized}`);
  if (options.diarize && !diarized) throw new Error("result: diarization was requested but the result is not diarized");

  await call("delete", "DELETE", `/transcriptions/${id}`, [204]);
  const gone = await call("verify-delete", "GET", `/transcriptions/${id}`, [404]);
  if (gone.json?.error?.code !== "transcription_not_found") throw new Error("verify-delete: expected transcription_not_found");
  log(`deleted id=${id}`);
  return { id, segments, speakers, diarized };
}

if (import.meta.main) {
  const { BACKEND_URL, BEARER, PTX_ORIGIN, AUDIO, DIARIZE } = process.env;
  if (!BACKEND_URL || !BEARER || !PTX_ORIGIN || !AUDIO) {
    console.error("BACKEND_URL, BEARER, PTX_ORIGIN and AUDIO are required");
    process.exit(2);
  }
  const extension = AUDIO.slice(AUDIO.lastIndexOf(".")).toLowerCase();
  const contentType = Object.hasOwn(CONTENT_TYPES, extension) ? CONTENT_TYPES[extension as keyof typeof CONTENT_TYPES] : undefined;
  if (!contentType) {
    console.error(`AUDIO must be one of ${Object.keys(CONTENT_TYPES).join(", ")}`);
    process.exit(2);
  }
  const diarize = DIARIZE === "true";
  runPrivateCloudE2E({ backendUrl: BACKEND_URL, bearer: BEARER, ptxOrigin: PTX_ORIGIN, audio: readFileSync(AUDIO), contentType, diarize })
    .then(({ id, segments, speakers, diarized }) =>
      console.log(`PASS id=${id} segments=${segments} speakers=${speakers} diarized=${diarized}`),
    )
    .catch((error: unknown) => {
      console.error(`FAIL ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    });
}
