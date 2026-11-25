import type { FirefliesSentence } from "../connectors/firefliesClient";

/**
 * A voice on the other side that spoke for less than this share of that side's talk, and for
 * less than this long, is not named separately. Engines put a speaker's short replies
 * ("Mm-hmm", "Sorry?") in a voice of their own often enough that a note with one caller would
 * otherwise show two.
 */
const STRAY_VOICE_MAX_SHARE = 0.05;
const STRAY_VOICE_MAX_SECONDS = 30;

/** Seconds between two ranges; 0 when they touch or overlap. */
function gap(a: FirefliesSentence, b: FirefliesSentence): number {
  return Math.max(0, a.start_time - b.end_time, b.start_time - a.end_time);
}

/**
 * Names for a stereo note's sentences. Channel 0 is the microphone and channel 1 everything the
 * device played, so:
 *
 * - the microphone side is always "Me", whatever voices the engine heard on it;
 * - the other side is "Them" when the engine told no voices apart there, or heard one;
 * - with several voices on the other side, each is "Them 1", "Them 2", … in order of first appearance, and a stray
 *   voice's sentences take the name of the voice that spoke nearest in time.
 *
 * "Them N" is the label a Mac call recording already uses for one person of the other side (callSpeakers.ts, where
 * the call window says who is speaking). Here the number comes from the audio: it is the order the voices were first
 * heard in, and it says nothing about the call's list of people. `speaker_id` keeps the engine's own label, so the
 * two are never confused: only a `call:` id names a person of the call. A sentence without a channel is returned as
 * it came.
 */
export function nameChannelSpeakers(sentences: readonly FirefliesSentence[]): FirefliesSentence[] {
  const others = sentences.filter((sentence) => sentence.channel === 1);
  const seconds = new Map<string, number>();
  for (const sentence of others) {
    if (!sentence.speaker_id) continue;
    seconds.set(sentence.speaker_id, (seconds.get(sentence.speaker_id) ?? 0) + Math.max(0, sentence.end_time - sentence.start_time));
  }
  const total = [...seconds.values()].reduce((sum, value) => sum + value, 0);
  // In order of first appearance: a Map keeps insertion order.
  const voices = [...seconds].filter(([, spoke]) => spoke >= STRAY_VOICE_MAX_SECONDS || spoke >= total * STRAY_VOICE_MAX_SHARE)
    .map(([id]) => id);
  const names = new Map(voices.map((id, index) => [id, `Them ${index + 1}`]));
  const named = others.filter((sentence) => sentence.speaker_id && names.has(sentence.speaker_id));

  return sentences.map((sentence) => {
    if (sentence.channel === 0) return { ...sentence, speaker_name: "Me" };
    if (sentence.channel !== 1) return sentence;
    if (voices.length < 2) return { ...sentence, speaker_name: "Them" };
    const own = sentence.speaker_id ? names.get(sentence.speaker_id) : undefined;
    if (own) return { ...sentence, speaker_name: own };
    const nearest = named.reduce((best, candidate) => gap(candidate, sentence) < gap(best, sentence) ? candidate : best);
    return { ...sentence, speaker_name: names.get(nearest.speaker_id!)! };
  });
}
