import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";

type Operation = "start" | "update" | "finish" | "digest";
let worker: Worker | null = null;
let nextId = 0;
const pending = new Map<number, { resolve: (hash: string | undefined) => void; reject: (error: Error) => void }>();

function hashWorker(): Worker | null {
  // Bun runs storage tests without a DOM. Production webviews always use the worker.
  if (typeof window === "undefined" || typeof document === "undefined"
    || "Bun" in globalThis) return null;
  if (!worker) {
    worker = new Worker(new URL("./audioHash.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (event: MessageEvent<{ request: number; hash?: string; error?: string }>) => {
      const job = pending.get(event.data.request);
      if (!job) return;
      pending.delete(event.data.request);
      if (event.data.error) job.reject(new Error(event.data.error));
      else job.resolve(event.data.hash);
    };
    worker.onerror = (event) => {
      for (const job of pending.values()) job.reject(new Error(event.message));
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
    target.postMessage({ request, stream, op, bytes });
  });
}

export async function hashAudioBytes(bytes: Uint8Array): Promise<string> {
  if (!hashWorker()) return bytesToHex(sha256(bytes));
  return (await send("digest", 0, bytes))!;
}

export async function audioHasher(): Promise<{ update(bytes: Uint8Array): Promise<void>; digest(): Promise<string> }> {
  if (!hashWorker()) {
    const hash = sha256.create();
    return { update: async (bytes) => { hash.update(bytes); }, digest: async () => bytesToHex(hash.digest()) };
  }
  const stream = ++nextId;
  await send("start", stream);
  return {
    update: async (bytes) => { await send("update", stream, bytes); },
    digest: async () => (await send("finish", stream))!,
  };
}
