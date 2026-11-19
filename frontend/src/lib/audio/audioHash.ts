import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";

type Operation = "start" | "update" | "finish" | "digest";
let worker: Worker | null = null;
let workerUnavailable = false;
let nextId = 0;
const pending = new Map<number, { resolve: (hash: string | undefined) => void; reject: (error: Error) => void }>();

function hashWorker(): Worker | null {
  // Some webviews expose a DOM but cannot construct or start module workers.
  if (typeof window === "undefined" || typeof document === "undefined"
    || "Bun" in globalThis || typeof Worker === "undefined" || workerUnavailable) return null;
  if (!worker) {
    try {
      worker = new Worker(new URL("./audioHash.worker.ts", import.meta.url), { type: "module" });
    } catch {
      workerUnavailable = true;
      return null;
    }
    worker.onmessage = (event: MessageEvent<{ request: number; hash?: string; error?: string }>) => {
      const job = pending.get(event.data.request);
      if (!job) return;
      pending.delete(event.data.request);
      if (event.data.error) job.reject(new Error(event.data.error));
      else job.resolve(event.data.hash);
    };
    worker.onerror = (event) => {
      workerUnavailable = true;
      for (const job of pending.values()) job.reject(new Error(event.message || "Audio hash worker failed to start"));
      pending.clear();
      worker?.terminate();
      worker = null;
    };
  }
  return worker;
}

function send(op: Operation, stream: number, bytes?: Uint8Array): Promise<string | undefined> {
  const target = hashWorker();
  if (!target) throw new Error("Audio hash worker is unavailable");
  const request = ++nextId;
  return new Promise((resolve, reject) => {
    pending.set(request, { resolve, reject });
    try { target.postMessage({ request, stream, op, bytes }); }
    catch (error) {
      for (const job of pending.values()) job.reject(error instanceof Error ? error : new Error(String(error)));
      pending.clear();
      target.terminate();
      worker = null;
      workerUnavailable = true;
    }
  });
}

export async function hashAudioBytes(bytes: Uint8Array): Promise<string> {
  if (!hashWorker()) return bytesToHex(sha256(bytes));
  try { return (await send("digest", 0, bytes))!; }
  catch { return bytesToHex(sha256(bytes)); }
}

export async function audioHasher(): Promise<{ update(bytes: Uint8Array): Promise<void>; digest(): Promise<string> }> {
  const mainThreadHasher = () => {
    const hash = sha256.create();
    return { update: async (bytes: Uint8Array) => { hash.update(bytes); }, digest: async () => bytesToHex(hash.digest()) };
  };
  if (!hashWorker()) return mainThreadHasher();
  const stream = ++nextId;
  try { await send("start", stream); }
  catch { return mainThreadHasher(); }
  return {
    update: async (bytes) => { await send("update", stream, bytes); },
    digest: async () => (await send("finish", stream))!,
  };
}
