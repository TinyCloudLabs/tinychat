// What exists only in this page, so a held tinycloud.chat page must not move under it (originMove.ts
// `deferOriginMove`). Each condition is the one the component hands to `useOriginMoveDeferral`; they live here as
// plain functions so they can be tested without mounting dialogs and sheets.
import type { Phase as ImportPhase } from "@/chat/ImportDialog";

/** Words typed and not yet sent or saved (a composer, a comment, a Canvas document, a pasted transcript). */
export const holdsTypedWords = (text: string): boolean => text.trim() !== "";

/** The Canvas document box: a document written and not yet pinned. */
export const canvasDraftHoldsMove = holdsTypedWords;

/** The import dialog while it reads a picked export, shows what it found, or writes it. */
export const importHoldsMove = (open: boolean, phase: ImportPhase): boolean =>
  open && (phase === "parsing" || phase === "ready" || phase === "importing");

/** The Upload sheet: a transcript pasted and not yet saved, or an audio file picked and not yet sent. */
export const uploadHoldsMove = (work: { pastedText: string; pickedFile: boolean }): boolean =>
  holdsTypedWords(work.pastedText) || work.pickedFile;
