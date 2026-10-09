import type { AudioBlobStore } from "../web/audioBlobStore";

/** The small part of Tauri's IPC used by the file-backed audio store. */
export interface CommandBridge {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
}

const MAX_CHUNK = 4 * 1024 * 1024;

/** Audio stays in Rust-owned files; the shared WebStore owns only its metadata. */
export function createFileAudioBlobStore(bridge: CommandBridge): AudioBlobStore {
  return {
    append: (id, chunk) => bridge.invoke<number>("append_audio_chunk", { id, bytes: Array.from(chunk) }),
    size: (id) => bridge.invoke<number>("audio_file_size", { id }),
    async read(id, offset, length) {
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0) {
        throw new Error("invalid_audio_range");
      }
      const size = await bridge.invoke<number>("audio_file_size", { id });
      const want = Math.max(0, Math.min(length, size - offset));
      const bytes = new Uint8Array(want);
      for (let at = 0; at < want;) {
        const len = Math.min(MAX_CHUNK, want - at);
        const reply = await bridge.invoke<ArrayBuffer | Uint8Array | number[]>("read_audio_chunk", { id, offset: offset + at, len });
        const part = reply instanceof Uint8Array ? reply : reply instanceof ArrayBuffer
          ? new Uint8Array(reply) : Uint8Array.from(reply);
        if (part.length !== len) throw new Error(`audio_short_read:${id}:${offset + at}`);
        bytes.set(part, at);
        at += len;
      }
      return bytes;
    },
    finalize: (id) => bridge.invoke<number>("finalize_audio_file", { id }),
    delete: (id) => bridge.invoke<void>("delete_audio_file", { id }),
  };
}
