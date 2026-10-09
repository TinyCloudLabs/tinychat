import { useEffect, useRef, useState } from "react";
import {
  createMomentFlow,
  type MomentField,
  type MomentFlow,
} from "./momentController";
import type { NotesApi } from "./notesApiStub";

/** The moment flow over the notes API; `markMoment` runs in the tap that calls `flow.begin()`. */
export function useMomentFlow(
  api: NotesApi,
  onError: (error: unknown) => void,
): { field: MomentField | null; flow: MomentFlow } {
  const [field, setField] = useState<MomentField | null>(null);
  const latest = useRef({ api, onError });
  latest.current = { api, onError };
  // The text as last written here: a write lands before the next render reads it back from the provider.
  const md = useRef(api.note?.md ?? "");
  const lastRead = useRef(api.note?.md ?? "");
  const read = api.note?.md ?? "";
  if (read !== lastRead.current) {
    lastRead.current = read;
    md.current = read;
  }
  const flow = useRef<MomentFlow | null>(null);
  flow.current ??= createMomentFlow(
    {
      markMoment: () => latest.current.api.markMoment(),
      readMd: () => md.current,
      writeMd: (next) => {
        const before = md.current;
        md.current = next;
        // A write the note refuses (not ready, or failed) is reported, and the text goes back to what is saved.
        void (async () => latest.current.api.setNoteText(next))().catch(
          (error: unknown) => {
            if (md.current === next) md.current = before;
            latest.current.onError(error);
          },
        );
      },
      onError: (error) => latest.current.onError(error),
    },
    setField,
  );
  useEffect(() => () => flow.current?.commit(), []);
  return { field, flow: flow.current };
}
