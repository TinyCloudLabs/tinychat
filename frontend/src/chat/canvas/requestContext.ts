import {
  activeBranch,
  activeAncestry,
  type ConversationCanvas,
  type DocumentVersion,
} from "./model";

export interface RequestMessage {
  id?: string;
  role: "system" | "user" | "assistant";
  content: string;
}

export interface RequestContextEntry extends RequestMessage {
  kind: "prelude" | "message" | "document" | "new-user";
  sourceId?: string;
  placementId?: string;
  documentTitle?: string;
  documentVersion?: number;
}

export interface CompactionInput {
  summary: string;
  coversThroughMessageId: string;
}

export interface RequestContextInput {
  canvas: ConversationCanvas;
  memoryPrelude?: string | null;
  meetingSystemBlock?: string | null;
  compaction?: CompactionInput | null;
  newUserMessage: string;
  newUserMessageId?: string;
  /** Preserve the pre-canvas behavior when no canvas has been promoted. */
  fullHistory?: readonly RequestMessage[];
}

export interface AssembledRequestContext {
  entries: RequestContextEntry[];
  messages: RequestMessage[];
  /** The exact browser-built payload handed to transport. */
  payload: RequestMessage[];
}

function versionFor(canvas: ConversationCanvas, documentId: string, versionId: string): DocumentVersion | null {
  const doc = canvas.documents.find((item) => item.id === documentId);
  return doc?.versions.find((version) => version.id === versionId) ?? null;
}

function documentMessage(canvas: ConversationCanvas, placement: ConversationCanvas["placements"][number]): RequestContextEntry[] {
  const version = versionFor(canvas, placement.documentId, placement.versionId);
  if (!version) return [];
  const title = canvas.documents.find((doc) => doc.id === placement.documentId)?.title ?? "Document";
  return [{
    role: "user" as const,
    content: `[Pinned document: ${title} — version ${version.version}]\n${version.markdown}\n[/Pinned document]`,
    kind: "document",
    placementId: placement.id,
    documentTitle: title,
    documentVersion: version.version,
  }];
}

function branchMessages(input: RequestContextInput): RequestContextEntry[] {
  const branch = activeBranch(input.canvas).filter((message) => message.id !== input.newUserMessageId);
  const checkpoint = input.compaction;
  if (!checkpoint) return branch.map(({ id, role, content }) => ({ id, role, content, kind: "message", sourceId: id }));
  const ancestry = activeAncestry(input.canvas);
  if (!ancestry.has(checkpoint.coversThroughMessageId)) return branch.map(({ id, role, content }) => ({ id, role, content, kind: "message", sourceId: id }));
  const coveredIndex = branch.findIndex((message) => message.id === checkpoint.coversThroughMessageId);
  if (coveredIndex < 0) return branch.map(({ id, role, content }) => ({ id, role, content, kind: "message", sourceId: id }));
  return [
    { role: "system", content: checkpoint.summary, kind: "prelude" },
    ...branch.slice(coveredIndex + 1).map(({ id, role, content }) => ({ id, role, content, kind: "message" as const, sourceId: id })),
  ];
}

/**
 * One semantic request projection. It intentionally does not include headers,
 * IDs, runtime tool state, or a request snapshot in persistence/logging.
 */
export function assembleRequestContext(input: RequestContextInput): AssembledRequestContext {
  const body = input.fullHistory && input.canvas.nodes.length === 0
    ? input.fullHistory.map((message) => ({ ...message, kind: "message" as const, sourceId: message.id }))
    : branchMessages(input);
  const placements = [...input.canvas.placements].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  const inserted = new Set<string>();
  const bodyWithDocuments: RequestContextEntry[] = [];
  for (const message of body) {
    for (const placement of placements) {
      const anchor = placement.beforeMessageId === messageIdFor(body, message) && (placement.slot ?? "before") === "before";
      if (anchor && !inserted.has(placement.id)) { bodyWithDocuments.push(...documentMessage(input.canvas, placement)); inserted.add(placement.id); }
    }
    bodyWithDocuments.push(message);
    for (const placement of placements) {
      const anchor = placement.beforeMessageId === messageIdFor(body, message) && placement.slot === "after";
      if (anchor && !inserted.has(placement.id)) { bodyWithDocuments.push(...documentMessage(input.canvas, placement)); inserted.add(placement.id); }
    }
  }
  for (const placement of placements) {
    if (placement.slot === "next-user" && !inserted.has(placement.id)) {
      bodyWithDocuments.push(...documentMessage(input.canvas, placement)); inserted.add(placement.id);
    }
  }
  for (const placement of placements) if (!inserted.has(placement.id)) bodyWithDocuments.push(...documentMessage(input.canvas, placement));
  const entries: RequestContextEntry[] = [
    ...(input.memoryPrelude ? [{ role: "system" as const, content: input.memoryPrelude, kind: "prelude" as const }] : []),
    ...(input.meetingSystemBlock ? [{ role: "system" as const, content: input.meetingSystemBlock, kind: "prelude" as const }] : []),
    ...bodyWithDocuments,
    { role: "user", content: input.newUserMessage, kind: "new-user" },
  ];
  const toMessage = ({ id: _id, kind: _kind, sourceId: _sourceId, placementId: _placementId, documentTitle: _documentTitle, documentVersion: _documentVersion, ...message }: RequestContextEntry): RequestMessage => message;
  return {
    entries,
    messages: entries.map(toMessage),
    payload: entries.map(toMessage),
  };
}

function messageIdFor(body: RequestMessage[], message: RequestMessage): string | null {
  return body.includes(message) ? message.id ?? null : null;
}

export type AttemptState = "draft" | "preparing" | "sent";

export interface RequestAttempt {
  threadId: string;
  state: AttemptState;
  /** Deliberately memory-only; never pass this object to a durable store. */
  payload?: RequestMessage[];
}

export function createRequestAttempt(threadId = ""): RequestAttempt { return { threadId, state: "draft" }; }

const attempts = new Map<string, RequestAttempt>();
const attemptListeners = new Map<string, Set<() => void>>();

/** Memory-only request attempt projection consumed by the Next Request rail. */
export function getRequestAttempt(threadId = ""): RequestAttempt {
  let attempt = attempts.get(threadId);
  if (!attempt) {
    attempt = createRequestAttempt(threadId);
    attempts.set(threadId, attempt);
  }
  return attempt;
}
export function subscribeRequestAttempt(threadId: string, listener: () => void): () => void {
  const listeners = attemptListeners.get(threadId) ?? new Set<() => void>();
  listeners.add(listener);
  attemptListeners.set(threadId, listeners);
  return () => listeners.delete(listener);
}
export function publishRequestAttempt(threadId: string, state: AttemptState, payload?: readonly RequestMessage[]): void {
  attempts.set(threadId, { threadId, state, payload: payload ? payload.map(({ id: _id, ...message }) => ({ ...message })) : undefined });
  for (const listener of attemptListeners.get(threadId) ?? []) listener();
}
export function resetRequestAttempt(threadId: string): void {
  publishRequestAttempt(threadId, "draft");
}
