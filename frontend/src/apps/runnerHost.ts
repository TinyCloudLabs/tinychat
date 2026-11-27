// One's side of the app runner (tc-run v1), free of React and the SDK so every rule is testable.
//
// An app kept in the owner's own Apps space (installed there; `fromSpace` in registry.ts) has no site of its own. One
// frames it at its own sub-address of one shared runner address. The runner page there says `tc-run/ready`; One reads
// the app's files from the owner's space with One's own session, checks each one against the app's release record,
// and posts them (`tc-run/files`). The runner serves them to the app from inside the browser, under fixed rules (the
// page may talk to the TinyCloud node only). From then on the app talks to One with the embed contract
// (embedHost.ts), like any framed app. The runner page lives in tinydrive runner/ for now.

import type { IncomingMessage } from "./embedHost";
import type { FramedOneApp } from "./registry";

export const RUN_VERSION = 1;

/** One file of the app, as posted to the runner (`path` is relative to the app's `app/` folder). */
export interface RunFile {
  path: string;
  type: string;
  body: ArrayBuffer;
}

export type RunnerMessage = { v: 1; type: "tc-run/files"; nonce: string; appId: string; entry: string; files: RunFile[] };

/** Why an app could not be handed over; One shows it in place of the app. */
export class RunAppError extends Error {
  constructor(readonly reason: "not-installed" | "bad-release" | "changed" | "unreadable", detail?: string) {
    super(`one_run_${reason}${detail ? `:${detail}` : ""}`);
    this.name = "RunAppError";
  }
}

const NONCE = /^[A-Za-z0-9_-]{16,64}$/;
// The same path rule as the runner (runner.js PATH): no "..", no leading dot, no empty part.
const PATH = /^[A-Za-z0-9_-][A-Za-z0-9._-]*(\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*$/;
const TYPES: Record<string, string> = {
  html: "text/html", js: "text/javascript", mjs: "text/javascript", css: "text/css", json: "application/json",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", svg: "image/svg+xml", webp: "image/webp", ico: "image/x-icon",
  wasm: "application/wasm", md: "text/markdown", txt: "text/plain", woff2: "font/woff2",
};
/** Files of the install itself, not of the app: never handed to the runner. */
const INSTALL_RECORDS = new Set(["app/release.json", "app/install.json"]);
const MAX_FILES = 500;
const MAX_BYTES = 95 * 1024 * 1024;
const SHA256 = /^[0-9a-f]{64}$/;

export const runFileType = (path: string) => TYPES[path.slice(path.lastIndexOf(".") + 1).toLowerCase()] ?? "application/octet-stream";

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * The runner sub-address label for an app id: base32 (a-z, 2-7) of SHA-256("tinycloud-app:" + id), 26 letters. The
 * runner computes the same and refuses files for any other app.
 */
export async function runnerSlug(appId: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`tinycloud-app:${appId}`)));
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  let out = "", bits = 0, value = 0;
  for (const byte of digest) {
    value = ((value << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5 && out.length < 26) {
      out += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    if (out.length >= 26) break;
  }
  return out;
}

/** Reads one record of the owner's Apps space as bytes; throws when it is missing or refused. */
export type AppsReader = (key: string) => Promise<Uint8Array>;

/**
 * The app's files from the owner's Apps space: `<id>/app/install.json` must exist (the install finished) and name
 * the release by its fingerprint (`release_sha256` = SHA-256 of the release's `files` list, as the app's install writes
 * it last), so a half-finished update never runs. `<id>/app/release.json` lists every file with its SHA-256 and size,
 * and each `app/` file must match both. Throws `RunAppError`.
 */
export async function readInstalledApp(read: AppsReader, appId: string): Promise<{ entry: string; files: RunFile[] }> {
  const json = async (key: string, reason: RunAppError["reason"]) => {
    let bytes: Uint8Array;
    try {
      bytes = await read(key);
    } catch {
      throw new RunAppError(reason);
    }
    try {
      return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    } catch {
      throw new RunAppError("bad-release", "json");
    }
  };
  const install = await json(`${appId}/app/install.json`, "not-installed") as { release_sha256?: unknown } | null;
  if (!install || typeof install !== "object" || typeof install.release_sha256 !== "string" || !SHA256.test(install.release_sha256)) {
    throw new RunAppError("not-installed", "install");
  }
  const release = await json(`${appId}/app/release.json`, "not-installed") as { app_id?: unknown; entry?: unknown; files?: unknown };
  if (!release || release.app_id !== appId || typeof release.entry !== "string" || !release.entry.startsWith("app/")) throw new RunAppError("bad-release");
  if (!release.files || typeof release.files !== "object") throw new RunAppError("bad-release", "files");
  const entry = release.entry.slice(4);
  const listed = Object.entries(release.files as Record<string, { sha256?: unknown; size?: unknown }>)
    .filter(([path]) => path.startsWith("app/") && !INSTALL_RECORDS.has(path));
  if (!PATH.test(entry) || listed.length === 0 || listed.length > MAX_FILES) throw new RunAppError("bad-release", "list");
  // Every file declares its size; the declared total is checked before any file is read.
  let declared = 0;
  for (const [path, want] of listed) {
    if (!PATH.test(path.slice(4)) || typeof want?.sha256 !== "string" || !SHA256.test(want.sha256)
      || typeof want.size !== "number" || !Number.isSafeInteger(want.size) || want.size < 0) throw new RunAppError("bad-release", path);
    declared += want.size;
  }
  if (declared > MAX_BYTES) throw new RunAppError("bad-release", "size");
  // The install record names this release: else an update wrote new files and a new release but never finished.
  if ((await sha256Hex(new TextEncoder().encode(JSON.stringify(release.files)))) !== install.release_sha256) throw new RunAppError("changed", "release");
  const files: RunFile[] = [];
  for (const [path, want] of listed) {
    const relative = path.slice(4);
    let bytes: Uint8Array;
    try {
      bytes = await read(`${appId}/${path}`);
    } catch {
      throw new RunAppError("unreadable", path);
    }
    if (bytes.byteLength !== want.size || (await sha256Hex(bytes)) !== want.sha256) throw new RunAppError("changed", path);
    files.push({ path: relative, type: runFileType(relative), body: bytes.slice().buffer as ArrayBuffer });
  }
  if (!files.some((file) => file.path === entry)) throw new RunAppError("bad-release", "entry");
  return { entry, files };
}

export interface RunnerHostDeps {
  app: FramedOneApp;
  /** The frame's window right now (`iframe.contentWindow`). */
  frameWindow(): unknown;
  /** Posts to the frame with targetOrigin = `app.origin`, moving the file bodies. */
  post(message: RunnerMessage, transfer: ArrayBuffer[]): void;
  /** True once One's session may read the app's files (asks the owner if it must). */
  canRead(): Promise<boolean>;
  read: AppsReader;
  /** The app could not be handed over, or the runner gave up; One says so in place of the app. */
  failed(reason: string): void;
  onError?(error: unknown): void;
}

/** One host per mounted frame, next to its EmbedHost. Acts only on the app's exact origin, from its frame's window. */
export class RunnerHost {
  private closed = false;
  private busy = false;
  private handedOver = false;

  constructor(private readonly deps: RunnerHostDeps) {}

  /**
   * True once One checked the app's files and handed them to the runner for the runner's latest ready. Until then the
   * frame is the runner page, so One answers no app hello from it (FramedAppScreen): a frame that runs anything else
   * (an old cached copy, a failed check) gets no grant.
   */
  get launched(): boolean {
    return this.handedOver && !this.closed;
  }

  handle(event: IncomingMessage): Promise<void> {
    if (this.closed || !this.deps.app.fromSpace || event.origin !== this.deps.app.origin) return Promise.resolve();
    const source = this.deps.frameWindow();
    if (!source || event.source !== source) return Promise.resolve();
    const data = event.data as { v?: unknown; type?: unknown; nonce?: unknown; reason?: unknown } | null;
    if (!data || typeof data !== "object" || data.v !== RUN_VERSION || typeof data.nonce !== "string" || !NONCE.test(data.nonce)) return Promise.resolve();
    if (data.type === "tc-run/failed") {
      this.handedOver = false;
      this.deps.failed(typeof data.reason === "string" ? data.reason.slice(0, 200) : "unknown");
      return Promise.resolve();
    }
    if (data.type !== "tc-run/ready" || this.busy) return Promise.resolve();
    this.busy = true;
    this.handedOver = false;
    return this.handOver(data.nonce).catch((error: unknown) => this.deps.onError?.(error)).finally(() => { this.busy = false; });
  }

  close(): void {
    this.closed = true;
  }

  private async handOver(nonce: string): Promise<void> {
    if (!(await this.deps.canRead())) {
      if (!this.closed) this.deps.failed("declined");
      return;
    }
    if (this.closed) return;
    let app: { entry: string; files: RunFile[] };
    try {
      app = await readInstalledApp(this.deps.read, this.deps.app.id);
    } catch (error) {
      if (!this.closed) this.deps.failed(error instanceof RunAppError ? error.reason : "unreadable");
      return;
    }
    if (this.closed) return;
    this.deps.post({ v: 1, type: "tc-run/files", nonce, appId: this.deps.app.id, entry: app.entry, files: app.files }, app.files.map((file) => file.body));
    this.handedOver = true;
  }
}
