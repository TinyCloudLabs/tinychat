// Checks that a recovered recording's bytes are playable media before recovery publishes them.
// A killed tab never ran MediaRecorder.stop(), so the recording may lack what a decoder needs.
//
// decodeAudioData materializes its whole input as float PCM (about 10 MB per minute of 44.1 kHz
// mono, double for stereo), so a decode is bounded by input size:
//  - A recording of at most DECODE_WINDOW_MAX_BYTES is decoded whole. An EncodingError or an empty
//    decode is then a verdict on every byte the recording has, and the caller may quarantine it.
//  - A larger recording is decoded only as a prefix (the first DECODE_WINDOW_MS of audio, cut at a
//    chunk boundary the session journal recorded while recording; see webStore appendChunk). A prefix
//    is NOT a file: MediaRecorder blob boundaries are not container boundaries (the spec guarantees
//    playability only for the combined blobs of a completed recording), and decodeAudioData is
//    specified for complete file data. Demuxers often tolerate a cut cluster or fragment, but that is
//    implementation behavior. A prefix that decodes is therefore a positive signal; one that fails
//    says nothing about the recording and the caller must not quarantine on it.
// The check cannot see corruption beyond what it decodes; the journal, not a decode, supplies the
// duration (see reconciledDurationMs in webStore).

/** The audio a prefix decode of a long recording covers. */
export const DECODE_WINDOW_MS = 10_000;
/** A prefix also closes at this many bytes, so a very high bitrate cannot make 10 s of audio large. */
export const DECODE_WINDOW_SOFT_BYTES = 1024 * 1024;
/** Hard bound, and the largest recording decoded whole: no decode is ever started on more bytes than this. */
export const DECODE_WINDOW_MAX_BYTES = 4 * 1024 * 1024;

export type DecodeFailureKind =
  /** The decoder looked at the bytes and says they are not media. Conclusive only when those were the whole recording. */
  | "invalid_media"
  /** The decoder could not run (unsupported, out of memory, no Web Audio, ...). The bytes are not judged. */
  | "resource";

export class DecodeCheckError extends Error {
  constructor(readonly kind: DecodeFailureKind, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "DecodeCheckError";
  }
}

/** Decodes `window` (the recording, or a prefix of it) and resolves with the duration of that window; throws DecodeCheckError. */
export type DecodeCheck = (window: Uint8Array, mimeType: string) => Promise<{ durationMs: number }>;

type DecodeContext = { decodeAudioData(data: ArrayBuffer): Promise<AudioBuffer>; close?(): Promise<void> };
type DecodeScope = {
  OfflineAudioContext?: typeof OfflineAudioContext; webkitOfflineAudioContext?: typeof OfflineAudioContext;
  AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext;
};

/**
 * Only an EncodingError means the decoder understood the request and found the bytes undecodable.
 * Anything else (NotSupportedError, out of memory, a closed or missing context) says nothing about the
 * bytes, and judging them by it would quarantine a good recording.
 */
const isInvalidMedia = (error: unknown): boolean => error instanceof DOMException && error.name === "EncodingError";

/** The browser's decoder. Always returns a check: a page without Web Audio fails each check as a resource failure. */
export function browserDecodeCheck(scope: DecodeScope = globalThis as DecodeScope): DecodeCheck {
  return async (window, mimeType) => {
    if (window.byteLength > DECODE_WINDOW_MAX_BYTES) {
      throw new RangeError(`Refusing to decode ${window.byteLength} bytes; a recovery decode is bounded to ${DECODE_WINDOW_MAX_BYTES}.`);
    }
    const Offline = scope.OfflineAudioContext ?? scope.webkitOfflineAudioContext;
    const Live = scope.AudioContext ?? scope.webkitAudioContext;
    if (!Offline && !Live) throw new DecodeCheckError("resource", "This browser has no Web Audio decoder.");
    let context: DecodeContext;
    try {
      context = Offline ? new Offline(1, 1, 44100) : new Live!();
    } catch (error) {
      throw new DecodeCheckError("resource", `The audio decoder could not be created: ${explain(error)}`, { cause: error });
    }
    try {
      // decodeAudioData detaches the buffer it is given.
      const buffer = await context.decodeAudioData(window.slice().buffer);
      if (!(buffer.length > 0 && buffer.duration > 0)) throw new DecodeCheckError("invalid_media", `The ${mimeType} audio decoded to nothing.`);
      return { durationMs: Math.round(buffer.duration * 1000) };
    } catch (error) {
      if (error instanceof DecodeCheckError) throw error;
      throw new DecodeCheckError(isInvalidMedia(error) ? "invalid_media" : "resource",
        `The ${mimeType} audio could not be decoded: ${explain(error)}`, { cause: error });
    } finally {
      await context.close?.();
    }
  };
}

const explain = (error: unknown) => (error instanceof Error ? `${error.name}: ${error.message}` : String(error));
