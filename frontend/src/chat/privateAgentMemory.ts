import type React from "react";
import type { PrivateAgentAccess } from "./useAgentEnablement";
import { renderMemoryBlock, runExtraction, type RunExtractionDeps } from "../lib/memory";
import type { ChatMessage } from "../lib/chatApi";

export function privateMemoryContext(access: React.MutableRefObject<PrivateAgentAccess>, doc: string | null): string {
  return access.current.active ? renderMemoryBlock(doc) : "";
}

/** Gate every automatic private-memory operation, including pending extraction writes. */
export async function runPrivateMemoryExtraction(
  access: React.MutableRefObject<PrivateAgentAccess>, recent: ChatMessage[], deps: RunExtractionDeps,
  isCurrent: () => boolean = () => true,
): Promise<void> {
  const lease = access.current;
  if (!lease.active || !isCurrent()) return;
  const current = () => access.current === lease && lease.active && isCurrent();
  await runExtraction(recent, {
    ...deps,
    getDoc: async () => {
      if (!current()) return null;
      const doc = await deps.getDoc();
      return current() ? doc : null;
    },
    complete: async (messages, opts) => {
      if (!current()) return "";
      const result = await deps.complete(messages, opts);
      return current() ? result : "";
    },
    setDoc: async (next) => { if (current()) await deps.setDoc(next); },
  });
}
