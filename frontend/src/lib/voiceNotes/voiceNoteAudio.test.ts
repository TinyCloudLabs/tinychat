// Voice-note audio for private cloud transcription. Rules:
//   1. the phone's AAC is decoded and written as 16 kHz mono 16-bit PCM WAV, the one accepted format
//      a webview can produce, which is exactly what PTX decodes every upload to;
//   2. the WAV is a canonical RIFF file PTX's ffprobe gate reads as one `wav` audio stream;
//   3. the hash and size sent at create are of the exact bytes uploaded;
//   4. a note over the phone's limit (or PTX's byte cap) is refused before anything is uploaded;
//   5. a type PTX already accepts is sent as recorded.

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  base64ToBytes,
  bytesToBase64,
  downmixToMono,
  encodeWavPcm16,
  prepareTranscriptionAudio,
  sha256Hex,
  TRANSCRIPTION_SAMPLE_RATE,
  VOICE_NOTE_TRANSCRIPTION_MAX_SECONDS,
  VoiceNoteAudioError,
  WAV_BYTES_PER_SECOND,
  type AudioDecoder,
} from "./voiceNoteAudio";

const RELAY_TYPES = ["audio/mpeg", "audio/wav", "audio/ogg"];
const MAX_BYTES = 120_960_000;

/** A decoder standing in for WebAudio: `seconds` of a 440 Hz tone at the requested rate. */
function toneDecoder(seconds: number, channels = 1): AudioDecoder & { calls: number[] } {
  const calls: number[] = [];
  const decode = (async (_bytes: ArrayBuffer, sampleRate: number) => {
    calls.push(sampleRate);
    const length = Math.round(seconds * sampleRate);
    const make = (phase: number) => Float32Array.from({ length }, (_, i) => 0.5 * Math.sin((2 * Math.PI * 440 * i) / sampleRate + phase));
    return { channels: Array.from({ length: channels }, (_, c) => make(c)), sampleRate };
  }) as AudioDecoder & { calls: number[] };
  decode.calls = calls;
  return decode;
}

const m4a = { mimeType: "audio/mp4", base64: bytesToBase64(new Uint8Array([0, 0, 0, 32, 102, 116, 121, 112])) };

describe("encodeWavPcm16", () => {
  test("a canonical 44-byte header for 16-bit mono PCM, then little-endian samples", () => {
    const wav = encodeWavPcm16(new Float32Array([0, 1, -1, 0.5, 2, -2]), 16_000);
    const view = new DataView(wav.buffer);
    const ascii = (offset: number) => String.fromCharCode(...wav.subarray(offset, offset + 4));
    expect(wav.byteLength).toBe(44 + 6 * 2);
    expect(ascii(0)).toBe("RIFF");
    expect(view.getUint32(4, true)).toBe(36 + 12);
    expect(ascii(8)).toBe("WAVE");
    expect(ascii(12)).toBe("fmt ");
    expect(view.getUint32(16, true)).toBe(16);
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(16_000);
    expect(view.getUint32(28, true)).toBe(32_000);
    expect(view.getUint16(32, true)).toBe(2);
    expect(view.getUint16(34, true)).toBe(16);
    expect(ascii(36)).toBe("data");
    expect(view.getUint32(40, true)).toBe(12);
    // Full scale both ways, and out-of-range input clamps instead of wrapping.
    expect([0, 1, 2, 3, 4, 5].map((i) => view.getInt16(44 + i * 2, true))).toEqual([0, 32767, -32768, 16384, 32767, -32768]);
  });
});

describe("downmixToMono", () => {
  test("mono is untouched; stereo is the average", () => {
    const mono = new Float32Array([0.1, 0.2]);
    expect(downmixToMono([mono])).toBe(mono);
    expect(Array.from(downmixToMono([new Float32Array([1, 0.5]), new Float32Array([0, -0.5])]))).toEqual([0.5, 0]);
  });
});

describe("base64 and sha256", () => {
  test("base64 round-trips binary larger than one chunk", () => {
    const bytes = Uint8Array.from({ length: 100_000 }, (_, i) => (i * 7) % 256);
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
    expect(bytesToBase64(bytes)).toBe(Buffer.from(bytes).toString("base64"));
  });

  test("sha256Hex is lowercase hex of the bytes", async () => {
    expect(await sha256Hex(new TextEncoder().encode("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

describe("prepareTranscriptionAudio", () => {
  test("the phone's AAC is decoded at 16 kHz and sent as WAV; size and hash describe the uploaded bytes", async () => {
    const decode = toneDecoder(3);
    const prepared = await prepareTranscriptionAudio(m4a, { acceptedContentTypes: RELAY_TYPES, maxBytes: MAX_BYTES, decode });
    expect(decode.calls).toEqual([TRANSCRIPTION_SAMPLE_RATE]);
    const bytes = base64ToBytes(prepared.base64);
    expect(prepared.contentType).toBe("audio/wav");
    expect(prepared.byteSize).toBe(bytes.byteLength);
    expect(prepared.byteSize).toBe(44 + 3 * WAV_BYTES_PER_SECOND);
    expect(prepared.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(prepared.durationSeconds).toBe(3);
  });

  test("stereo input is downmixed to one channel", async () => {
    const prepared = await prepareTranscriptionAudio(m4a, {
      acceptedContentTypes: RELAY_TYPES,
      maxBytes: MAX_BYTES,
      decode: toneDecoder(1, 2),
    });
    expect(new DataView(base64ToBytes(prepared.base64).buffer).getUint16(22, true)).toBe(1);
  });

  test("a note over the phone's limit is refused before anything else happens", async () => {
    const err = await prepareTranscriptionAudio(m4a, {
      acceptedContentTypes: RELAY_TYPES,
      maxBytes: MAX_BYTES,
      maxSeconds: 2,
      decode: toneDecoder(2.5),
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VoiceNoteAudioError);
    expect((err as VoiceNoteAudioError).code).toBe("recording_too_long_for_phone");
    expect(VOICE_NOTE_TRANSCRIPTION_MAX_SECONDS).toBe(600);
  });

  test("PTX's byte cap applies to the WAV", async () => {
    const err = await prepareTranscriptionAudio(m4a, {
      acceptedContentTypes: RELAY_TYPES,
      maxBytes: 1_000,
      decode: toneDecoder(1),
    }).catch((e: unknown) => e);
    expect((err as VoiceNoteAudioError).code).toBe("recording_too_large");
  });

  test("a decoder that ignores the requested rate is a failure, never a mislabeled WAV", async () => {
    const wrongRate: AudioDecoder = async () => ({ channels: [new Float32Array(44_100)], sampleRate: 44_100 });
    const err = await prepareTranscriptionAudio(m4a, { acceptedContentTypes: RELAY_TYPES, maxBytes: MAX_BYTES, decode: wrongRate })
      .catch((e: unknown) => e);
    expect((err as VoiceNoteAudioError).code).toBe("decode_failed");
  });

  test("a type PTX accepts is sent as recorded, without decoding", async () => {
    const decode = toneDecoder(1);
    const prepared = await prepareTranscriptionAudio(m4a, {
      acceptedContentTypes: [...RELAY_TYPES, "audio/mp4"],
      maxBytes: MAX_BYTES,
      decode,
    });
    expect(decode.calls).toEqual([]);
    expect(prepared).toEqual({
      contentType: "audio/mp4",
      base64: m4a.base64,
      byteSize: 8,
      sha256: createHash("sha256").update(base64ToBytes(m4a.base64)).digest("hex"),
      durationSeconds: null,
    });
  });

  test("without WAV among the accepted types there is nothing to send", async () => {
    const err = await prepareTranscriptionAudio(m4a, { acceptedContentTypes: ["audio/mpeg"], maxBytes: MAX_BYTES, decode: toneDecoder(1) })
      .catch((e: unknown) => e);
    expect((err as VoiceNoteAudioError).code).toBe("unsupported_recording");
  });
});

// PTX admits an upload only if ffprobe reads it as ONE audio stream of the declared container
// (format_name matching /(^|,)wav(,|$)/), 1–2 channels, a positive duration. Run the same probe
// on the bytes this module produces, where ffprobe is installed.
const ffprobe = Bun.which("ffprobe");
describe.if(ffprobe !== null)("ffprobe (PTX's upload gate)", () => {
  test("reads the prepared WAV as one 16 kHz mono wav stream of the note's length", async () => {
    const prepared = await prepareTranscriptionAudio(m4a, { acceptedContentTypes: RELAY_TYPES, maxBytes: MAX_BYTES, decode: toneDecoder(2.5) });
    const dir = mkdtempSync(join(tmpdir(), "voice-note-wav-"));
    try {
      const path = join(dir, "note.wav");
      writeFileSync(path, base64ToBytes(prepared.base64));
      const proc = Bun.spawnSync([
        ffprobe!, "-v", "error", "-show_entries", "stream=codec_type,codec_name,channels,sample_rate:format=duration,format_name", "-of", "json", path,
      ]);
      expect(proc.exitCode).toBe(0);
      const probe = JSON.parse(proc.stdout.toString()) as {
        streams: { codec_type: string; codec_name: string; channels: number; sample_rate: string }[];
        format: { format_name: string; duration: string };
      };
      expect(probe.streams).toEqual([{ codec_type: "audio", codec_name: "pcm_s16le", channels: 1, sample_rate: "16000" }]);
      expect(probe.format.format_name).toMatch(/(^|,)wav(,|$)/);
      expect(Number(probe.format.duration)).toBeCloseTo(2.5, 3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
