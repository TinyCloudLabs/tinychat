/**
 * Anonymous speaker names, numbered within one note: "Speaker 1", "Speaker 2", …
 * A name says nothing about who spoke. "Speaker 1" in two notes is not known to be
 * the same person, and no name stands for the account owner. A single-channel
 * on-device transcript has one speaker, `anonymousSpeakerName(1)`.
 */
export function anonymousSpeakerName(ordinal: number): string {
  return `Speaker ${ordinal}`;
}
