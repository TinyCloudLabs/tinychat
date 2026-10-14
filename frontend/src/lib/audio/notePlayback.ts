import { createContext } from "react";

/** Shared by a note's transcript and its existing audio player, including saved-note sheets. */
export interface NotePlayback {
  seek: { seconds: number; nonce: number } | null;
  playFrom: (seconds: number) => void;
  elapsed: number;
  playing: boolean;
  onClock: (elapsed: number, playing: boolean) => void;
}

export const NotePlaybackContext = createContext<NotePlayback | null>(null);
