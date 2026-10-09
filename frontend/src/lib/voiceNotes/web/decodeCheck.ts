// Proves that a recovered recording's bytes are playable media before recovery publishes
// them. A killed tab never ran MediaRecorder.stop(), so its prefix may lack the container
// metadata a decoder needs; such a prefix is quarantined instead of shown as a playable note.
//
// Only a bounded window is ever decoded. decodeAudioData materializes the whole input as float
// PCM (about 10 MB per minute of 44.1 kHz mono, double for stereo), so a normal long note must
// never be handed over whole. The window is the container header plus the first DECODE_WINDOW_MS of
// audio, cut at a chunk boundary the session journal recorded while recording (webStore
// appendChunk). Why a prefix is enough:
//  - WebM (Chrome, Firefox): the first MediaRecorder chunk holds the EBML header, Segment, Info and
//    Tracks, then the first Cluster; every later chunk continues clusters and has no header of its
//    own. A prefix is therefore a decodable file; a slice from the middle is not.
//  - MP4 (Safari, recent Chrome): fragmented. The first chunk is ftyp + moov (+ the first moof/mdat),
//    later chunks are further moof/mdat fragments. A prefix is a shorter fragmented file.
// A cut inside the last cluster or fragment is tolerated by the browsers' demuxers: they decode the
// frames that are complete. The window cannot see corruption after it; the journal, not a decode,
// supplies the duration (see reconciledDurationMs in webStore).

/** The audio a recovery decode may cover. */
export const DECODE_WINDOW_MS = 10_000;
/** A window also closes at this many bytes, so a very high bitrate cannot make 10 s of audio large. */
export const DECODE_WINDOW_SOFT_BYTES = 1024 * 1024;
/** Hard bound: no decode is ever started on more bytes than this, whatever a store reports. */
export const DECODE_WINDOW_MAX_BYTES = 4 * 1024 * 1024;

export type DecodeFailureKind =
  /** The decoder looked at the bytes and says they are not media. The recording is quarantined. */
  | "invalid_media"
  /** The decoder could not run (unsupported, out of memory, no Web Audio, ...). The bytes are not judged. */
  | "resource";

export class DecodeCheckError extends Error {
  constructor(readonly kind: DecodeFailureKind, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "DecodeCheckError";
  }
}

/** Decodes `window` (a prefix of the recording) and resolves with the duration of that window; throws DecodeCheckError. */
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
