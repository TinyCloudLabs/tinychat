import { useEffect, useRef, useState } from "react";
import { usePrimeAccessoryBarOnPress } from "./keyboardInset";
import {
  createMomentFlow,
  type MomentField,
  type MomentFlow,
} from "./momentController";

export interface MomentNotes {
  /** The recording time in ms, taken now; may throw when nothing is recording. */
  markMoment(): number | Promise<number>;
  /** The note as it reads now: what is typed and unsaved, else what is saved. */
  text: string;
  /** Takes the new text; saving it and reporting a failure are the caller's. */
  write(md: string): void;
}

/** The moment flow over the notes; `markMoment` runs in the tap that calls `flow.begin()`. */
export function useMomentFlow(
  notes: MomentNotes,
  onError: (error: unknown) => void,
): { field: MomentField | null; flow: MomentFlow } {
  const [field, setField] = useState<MomentField | null>(null);
  usePrimeAccessoryBarOnPress(".pr-mark, .pr-vnotes");
  const latest = useRef({ notes, onError });
  latest.current = { notes, onError };
  // The text as last written here: a write lands before the next render reads it back.
  const md = useRef(notes.text);
  const lastRead = useRef(notes.text);
  if (notes.text !== lastRead.current) {
    lastRead.current = notes.text;
    md.current = notes.text;
  }
  const flow = useRef<MomentFlow | null>(null);
  flow.current ??= createMomentFlow(
    {
      markMoment: () => latest.current.notes.markMoment(),
      readMd: () => md.current,
      writeMd: (next) => {
        md.current = next;
        latest.current.notes.write(next);
      },
      onError: (error) => latest.current.onError(error),
    },
    setField,
  );
  useEffect(() => () => flow.current?.commit(), []);
  return { field, flow: flow.current };
}

