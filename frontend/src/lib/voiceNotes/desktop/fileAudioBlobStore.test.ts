import { expect, test } from "bun:test";
import { nativeRecordingSource } from "../nativeVoiceNotes";
import { bytesToBase64 } from "../voiceNoteAudio";
import { createFileAudioBlobStore } from "./fileAudioBlobStore";

test("an 86 MiB generated note keeps every 4 MiB read and T18 upload range exact", async () => {
  const mib = 1024 * 1024;
  const size = 86 * mib + 123;
  const requests: { offset: number; len: number }[] = [];
  const bridge = {
    async invoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
      if (command === "audio_file_size") return size as T;
      if (command !== "read_audio_chunk") throw new Error(command);
      const offset = Number(args.offset);
      const len = Number(args.len);
      requests.push({ offset, len });
      if (len > 4 * mib || offset < 0 || offset + len > size) throw new Error("bad native range");
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) bytes[i] = (offset + i) % 251;
      return bytes as T;
    },
  };
  const audio = createFileAudioBlobStore(bridge);
  const acrossBoundary = await audio.read("note", 4 * mib - 13, 4 * mib + 37);
  expect(requests).toEqual([{ offset: 4 * mib - 13, len: 4 * mib },
    { offset: 8 * mib - 13, len: 37 }]);
  expect(acrossBoundary[0]).toBe((4 * mib - 13) % 251);
  expect(acrossBoundary[4 * mib - 1]).toBe((8 * mib - 14) % 251);
  expect(acrossBoundary[4 * mib]).toBe((8 * mib - 13) % 251);
  expect(acrossBoundary.at(-1)).toBe((8 * mib + 23) % 251);

  requests.length = 0;
  const source = nativeRecordingSource({ id: "note", mimeType: "audio/mpeg", sizeBytes: size }, {
    async readAudioChunk({ id, offset, length }) {
      const bytes = await audio.read(id, offset, length);
      return { id, offset, base64: bytesToBase64(bytes), bytesRead: bytes.length,
        size, eof: offset + bytes.length >= size };
    },
  });
  for (let offset = 0; offset < size; offset += mib) {
    const length = Math.min(mib, size - offset);
    const part = await source.readPart(offset, length);
    expect(part.length).toBe(length);
    expect(part[0]).toBe(offset % 251);
    expect(part.at(-1)).toBe((offset + length - 1) % 251);
  }
  expect(requests.length).toBe(87);
  for (let i = 0; i < requests.length; i++) {
    expect(requests[i]).toEqual({ offset: i * mib, len: Math.min(mib, size - i * mib) });
  }
  expect(requests.at(-1)).toEqual({ offset: 86 * mib, len: 123 });
});
