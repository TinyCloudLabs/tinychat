// Proves that a recovered recording's bytes are playable media before recovery publishes
// them. A killed tab never ran MediaRecorder.stop(), so its prefix may lack the container
// metadata a decoder needs; such a prefix is quarantined instead of shown as a playable note.

/** Decodes `head` (the first bytes of a `totalBytes` recording) and resolves with the recording's duration; rejects when it cannot be decoded. */
export type DecodeCheck = (head: Uint8Array, mimeType: string, totalBytes: number) => Promise<{ durationMs: number }>;

/** Decoding expands to PCM, so only the start of a long recording is decoded: the container header lives there. */
export const DECODE_CHECK_MAX_BYTES = 8 * 1024 * 1024;

type DecodeContext = { decodeAudioData(data: ArrayBuffer): Promise<AudioBuffer>; close?(): Promise<void> };

/** The browser's decoder, or null when the page has no Web Audio (a recorder cannot exist there either). */
export function browserDecodeCheck(): DecodeCheck | null {
  const scope = globalThis as {
    OfflineAudioContext?: typeof OfflineAudioContext; webkitOfflineAudioContext?: typeof OfflineAudioContext;
    AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext;
  };
  const Offline = scope.OfflineAudioContext ?? scope.webkitOfflineAudioContext;
  const Live = scope.AudioContext ?? scope.webkitAudioContext;
  if (!Offline && !Live) return null;
  return async (head, mimeType, totalBytes) => {
    const context: DecodeContext = Offline ? new Offline(1, 1, 44100) : new Live!();
    try {
      // decodeAudioData detaches the buffer it is given.
      const buffer = await context.decodeAudioData(head.slice().buffer);
      if (!(buffer.length > 0 && buffer.duration > 0)) throw new Error(`The ${mimeType} audio decoded to nothing.`);
      return { durationMs: Math.round(buffer.duration * 1000 * (totalBytes / head.byteLength)) };
    } catch (error) {
      throw Object.assign(new Error(`The ${mimeType} audio could not be decoded: ${error instanceof Error ? error.message : String(error)}`),
        { cause: error });
    } finally {
      await context.close?.();
    }
  };
}
