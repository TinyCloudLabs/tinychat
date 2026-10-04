// Voice-note audio in a form TinyCloud Private Transcription (PTX) accepts.
//
// The phone records AAC in MPEG-4 (`audio/mp4`, .m4a). PTX and the TinyChat
// relay accept only `audio/mpeg`, `audio/wav` and `audio/ogg` (PTX checks the
// container with ffprobe), and neither phone OS can encode MP3 or Ogg without
// a bundled encoder. So the webview decodes the note with WebAudio, already
// resampled to 16 kHz mono, and writes a 16-bit PCM WAV. 16 kHz mono s16le is
// exactly what PTX decodes every upload to before its speech detection, so
// the conversion loses nothing PTX would have kept.
//
// Cost: the WAV is 32 KB per second (1.9 MB per minute), about 4× the AAC,
// and the decode holds the whole note in memory. VOICE_NOTE_TRANSCRIPTION_MAX_SECONDS
// bounds both. If PTX and the relay ever accept `audio/mp4`, the original
// bytes are sent as they are (see `prepareTranscriptionAudio`).

/** The rate PTX decodes every upload to. */
export const TRANSCRIPTION_SAMPLE_RATE = 16_000;
export const WAV_CONTENT_TYPE = "audio/wav";
/** 16-bit mono at TRANSCRIPTION_SAMPLE_RATE. */
export const WAV_BYTES_PER_SECOND = TRANSCRIPTION_SAMPLE_RATE * 2;
const WAV_HEADER_BYTES = 44;

/**
 * Longest note this app converts and uploads (v1). Everything happens in the
 * webview: the decode, the WAV (19 MB at this cap) and its base64 copy for the
 * native HTTP bridge. Well under PTX's own limits (2 hours, ~121 MB).
 */
export const VOICE_NOTE_TRANSCRIPTION_MAX_SECONDS = 10 * 60;

/**
 * Compressed bytes per second allowed before decoding: twice the phone's
 * 64 kbps AAC. A recording larger than `maxSeconds` of this is refused
 * without being decoded, even when its length is not known.
 */
export const MAX_ENCODED_BYTES_PER_SECOND = 16_000;

export interface DecodedAudio {
  /** One array per channel, at `sampleRate`. */
  channels: Float32Array[];
  sampleRate: number;
}

/** Decodes a compressed recording to PCM at `sampleRate`. */
export type AudioDecoder = (bytes: ArrayBuffer, sampleRate: number) => Promise<DecodedAudio>;

/** A failure preparing the audio, with a stable code like every private cloud failure. */
export class VoiceNoteAudioError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "VoiceNoteAudioError";
    this.code = code;
  }
}

type OfflineAudioContextCtor = new (channels: number, length: number, sampleRate: number) => {
  decodeAudioData(data: ArrayBuffer): Promise<{ numberOfChannels: number; sampleRate: number; getChannelData(i: number): Float32Array }>;
};

/**
 * WebAudio's decoder (WKWebView and Android WebView both decode AAC). An
 * OfflineAudioContext at 16 kHz makes `decodeAudioData` resample for us.
 */
export const webAudioDecoder: AudioDecoder = async (bytes, sampleRate) => {
  const g = globalThis as unknown as { OfflineAudioContext?: OfflineAudioContextCtor; webkitOfflineAudioContext?: OfflineAudioContextCtor };
  const Ctor = g.OfflineAudioContext ?? g.webkitOfflineAudioContext;
  if (!Ctor) throw new VoiceNoteAudioError("decode_unavailable", "This app cannot decode audio here.");
  let buffer;
  try {
    buffer = await new Ctor(1, 1, sampleRate).decodeAudioData(bytes);
  } catch {
    throw new VoiceNoteAudioError("decode_failed", "This phone could not read the recording to transcribe it.");
  }
  const channels: Float32Array[] = [];
  for (let i = 0; i < buffer.numberOfChannels; i++) channels.push(buffer.getChannelData(i));
  return { channels, sampleRate: buffer.sampleRate };
};

/** The average of the channels; a mono recording is returned as is. */
export function downmixToMono(channels: readonly Float32Array[]): Float32Array {
  if (channels.length === 0) return new Float32Array(0);
  if (channels.length === 1) return channels[0]!;
  const length = Math.min(...channels.map((c) => c.length));
  const out = new Float32Array(length);
  for (const channel of channels) {
    for (let i = 0; i < length; i++) out[i] = (out[i] ?? 0) + (channel[i] ?? 0) / channels.length;
  }
  return out;
}

/** A canonical 44-byte-header RIFF/WAVE file: PCM, 16-bit little-endian, mono. */
export function encodeWavPcm16(samples: Float32Array, sampleRate: number): Uint8Array {
  const dataBytes = samples.length * 2;
  const out = new Uint8Array(WAV_HEADER_BYTES + dataBytes);
  const view = new DataView(out.buffer);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) out[offset + i] = text.charCodeAt(i);
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  ascii(36, "data");
  view.setUint32(40, dataBytes, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i] ?? 0));
    view.setInt16(WAV_HEADER_BYTES + i * 2, Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), true);
  }
  return out;
}

export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  // Chunked: String.fromCharCode(...hugeArray) overflows the call stack.
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** What is uploaded to PTX for one note. */
export interface PreparedTranscriptionAudio {
  contentType: string;
  /** base64 of the bytes: what the native HTTP bridge sends. */
  base64: string;
  byteSize: number;
  sha256: string;
  /** Null when the bytes were sent as recorded (not decoded here). */
  durationSeconds: number | null;
}

/**
 * The note's audio as PTX will take it: as recorded when its type is
 * accepted, otherwise decoded and written as 16 kHz mono WAV. Refuses a
 * recording over `maxSeconds` or `maxBytes` before anything is uploaded.
 */
export async function prepareTranscriptionAudio(
  audio: { mimeType: string; base64: string },
  options: {
    acceptedContentTypes: readonly string[];
    maxBytes: number;
    maxSeconds?: number;
    decode?: AudioDecoder;
  },
): Promise<PreparedTranscriptionAudio> {
  const maxSeconds = options.maxSeconds ?? VOICE_NOTE_TRANSCRIPTION_MAX_SECONDS;
  const tooLarge = () => new VoiceNoteAudioError("recording_too_large", "The recording is larger than the private cloud limit.");
  const recorded = base64ToBytes(audio.base64);
  if (options.acceptedContentTypes.includes(audio.mimeType)) {
    if (recorded.byteLength > options.maxBytes) throw tooLarge();
    return {
      contentType: audio.mimeType,
      base64: audio.base64,
      byteSize: recorded.byteLength,
      sha256: await sha256Hex(recorded),
      durationSeconds: null,
    };
  }
  if (!options.acceptedContentTypes.includes(WAV_CONTENT_TYPE)) {
    throw new VoiceNoteAudioError("unsupported_recording", "Private cloud transcription does not accept this recording's format.");
  }
  // Refuse an over-long note before decoding it (the decode holds all of it in memory).
  if (recorded.byteLength > maxSeconds * MAX_ENCODED_BYTES_PER_SECOND) {
    throw new VoiceNoteAudioError("recording_too_long_for_phone", "This note is too long to transcribe from the phone.");
  }
  const decoded = await (options.decode ?? webAudioDecoder)(recorded.buffer as ArrayBuffer, TRANSCRIPTION_SAMPLE_RATE);
  if (decoded.sampleRate !== TRANSCRIPTION_SAMPLE_RATE) {
    throw new VoiceNoteAudioError("decode_failed", "This phone could not convert the recording to transcribe it.");
  }
  const mono = downmixToMono(decoded.channels);
  const durationSeconds = mono.length / TRANSCRIPTION_SAMPLE_RATE;
  if (mono.length === 0) throw new VoiceNoteAudioError("no_speech", "The recording is empty.");
  if (durationSeconds > maxSeconds) {
    throw new VoiceNoteAudioError("recording_too_long_for_phone", "This note is too long to transcribe from the phone.");
  }
  const wav = encodeWavPcm16(mono, TRANSCRIPTION_SAMPLE_RATE);
  if (wav.byteLength > options.maxBytes) throw tooLarge();
  return {
    contentType: WAV_CONTENT_TYPE,
    base64: bytesToBase64(wav),
    byteSize: wav.byteLength,
    sha256: await sha256Hex(wav),
    durationSeconds,
  };
}
