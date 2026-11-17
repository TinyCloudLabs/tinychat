// When a chat may load the images a reply points to, and when it asks first.
//
// An image address is fetched the moment it renders, and its query string can carry anything the model has seen. A chat
// that has not touched the owner's data or other sites' content has nothing to carry, so its images load as usual. Once
// one has, the chat is MARKED: every image asks first ("Load this image?") and is allowed one address at a time. A mark
// never clears within a conversation.
//
// What marks a conversation: content from outside entering the model's context (a web search, a meeting transcript or
// other tool result, a pinned document, text pasted or dropped into the composer). The mark is set the moment that
// content enters, before the reply that follows it renders, and is written onto every stored message (`provenance`, a
// top-level sibling of `message`, like `receipt`), so a reload derives it again from the stored history. History that
// carries no provenance, or any part other than text, is unknown and counts as marked: an imported, older or shared
// conversation is marked. Typing alone never marks.
import { useSyncExternalStore } from "react";

export interface Provenance { v: 1; outside: boolean }

const marked = new Set<string>();
const allowed = new Map<string, Set<string>>();
const listeners = new Set<() => void>();
let pasted = false;

const emit = () => { for (const listener of [...listeners]) listener(); };
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

/** Outside content has entered this conversation's context. Idempotent; never undone. */
export function markOutsideContent(threadId: string | null | undefined): void {
  if (!threadId || marked.has(threadId)) return;
  marked.add(threadId);
  emit();
}

/** A conversation with no known id cannot be vouched for, so it is marked. */
export function isConversationMarked(threadId: string | null | undefined): boolean {
  return !threadId || marked.has(threadId);
}

export function allowImage(threadId: string | null | undefined, address: string): void {
  if (!threadId) return;
  let set = allowed.get(threadId);
  if (!set) allowed.set(threadId, set = new Set());
  if (set.has(address)) return;
  set.add(address);
  emit();
}

/** Allowed for this conversation, for this exact address (query string included), not for its site. */
export function isImageAllowed(threadId: string | null | undefined, address: string | null): boolean {
  return !!threadId && address !== null && !!allowed.get(threadId)?.has(address);
}

/** The composer received pasted or dropped text. Consumed by the next turn (`takePastedText`). */
export function notePastedText(): void { pasted = true; }
export function takePastedText(): boolean { const was = pasted; pasted = false; return was; }

/** Parts that carry only what the model or the owner wrote. Anything else (a tool part, a file, an unknown type) is outside content. */
const OWN_PART_TYPES: Record<string, true> = { text: true, reasoning: true };

/** True when every stored message vouches for itself (provenance v1, no outside content) and holds only text parts. */
export function storedHistoryIsClean(items: readonly unknown[]): boolean {
  return items.every((raw) => {
    const item = raw as { provenance?: Partial<Provenance>; message?: { content?: unknown; attachments?: unknown } } | null;
    if (!item || item.provenance?.v !== 1 || item.provenance.outside !== false) return false;
    const message = item.message;
    if (!message || !Array.isArray(message.content)) return false;
    if (Array.isArray(message.attachments) && message.attachments.length > 0) return false;
    return message.content.every((part) => OWN_PART_TYPES[(part as { type?: unknown } | null)?.type as string] === true);
  });
}

/** Derive the mark from a thread's stored history. A thread with no messages yet is a new chat and stays unmarked. */
export function adoptStoredHistory(threadId: string, items: readonly unknown[]): void {
  if (items.length > 0 && !storedHistoryIsClean(items)) markOutsideContent(threadId);
}

/** Stamp a message about to be stored with what the conversation is at this moment. */
export function stampProvenance<T extends object>(item: T, threadId: string): T {
  (item as { provenance?: Provenance }).provenance = { v: 1, outside: isConversationMarked(threadId) };
  return item;
}

export function useConversationMarked(threadId: string | null | undefined): boolean {
  return useSyncExternalStore(subscribe, () => isConversationMarked(threadId), () => true);
}

export function useImageAllowed(threadId: string | null | undefined, address: string | null): boolean {
  return useSyncExternalStore(subscribe, () => isImageAllowed(threadId, address), () => false);
}

export function resetImageGateForTests(): void {
  marked.clear();
  allowed.clear();
  pasted = false;
  emit();
}
