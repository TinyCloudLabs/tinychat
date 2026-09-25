import type { StoredMessageItem, ThreadDoc } from "../../lib/threadStore";

export type CanvasRole = "user" | "assistant" | "system";

export interface CanvasMessage {
  id: string;
  parentId: string | null;
  role: CanvasRole;
  content: string;
  createdAt: string;
  /** Meeting evidence is deliberately runtime-only and never durable. */
  transient?: boolean;
  position?: { x: number; y: number };
}

export interface DocumentVersion {
  id: string;
  documentId: string;
  version: number;
  markdown: string;
  createdAt: string;
}

export interface CanvasDocument {
  id: string;
  title: string;
  versions: DocumentVersion[];
  createdAt: string;
  updatedAt: string;
}

export interface DocumentPlacement {
  id: string;
  documentId: string;
  versionId: string;
  /** Explicit request order. Array/geometry order is never semantic. */
  order: number;
  /** Semantic insertion anchor. Geometry/order is only a presentation aid. */
  beforeMessageId?: string | null;
  slot?: "before" | "after" | "next-user";
}

export interface DocumentPlacementTarget {
  beforeMessageId?: string | null;
  slot: "before" | "next-user";
}

export interface ConversationCanvas {
  version: 1;
  threadId: string;
  nodes: CanvasMessage[];
  activeHeadId: string | null;
  documents: CanvasDocument[];
  placements: DocumentPlacement[];
}

export interface LegacyMessageLike {
  id: string;
  role: CanvasRole;
  content: string;
  createdAt?: string;
}

export function messageText(item: StoredMessageItem): string {
  return (item.message?.content ?? [])
    .map((part) => {
      const value = part as { type?: unknown; text?: unknown };
      return value.type === "text" && typeof value.text === "string" ? value.text : "";
    })
    .join("");
}

/** Convert the incumbent linear history to the canonical graph. */
export function normalizeLegacyMessages(
  messages: readonly (StoredMessageItem | LegacyMessageLike)[],
  threadId = "",
): ConversationCanvas {
  const nodes: CanvasMessage[] = [];
  for (const item of messages) {
    const itemMeta = item as StoredMessageItem & { transient?: boolean; meetingEvidence?: boolean };
    if (itemMeta.transient || itemMeta.meetingEvidence) continue;
    const value = "message" in item ? item.message : item;
    const id = typeof value?.id === "string" ? value.id : "";
    const role = value?.role;
    if (!id || (role !== "user" && role !== "assistant" && role !== "system")) continue;
    const content = "message" in item ? messageText(item) : item.content;
    nodes.push({
      id,
      parentId: nodes.at(-1)?.id ?? null,
      role,
      content,
      createdAt: typeof (value as { createdAt?: unknown }).createdAt === "string"
        ? (value as { createdAt: string }).createdAt
        : new Date(0).toISOString(),
    });
  }
  return {
    version: 1,
    threadId,
    nodes,
    activeHeadId: nodes.at(-1)?.id ?? null,
    documents: [],
    placements: [],
  };
}

export function normalizeLegacyThread(doc: ThreadDoc): ConversationCanvas {
  return normalizeLegacyMessages(doc.messages, doc.id);
}

export function activeAncestry(canvas: Pick<ConversationCanvas, "nodes" | "activeHeadId">): Set<string> {
  const byId = new Map(canvas.nodes.map((node) => [node.id, node]));
  const result = new Set<string>();
  let id = canvas.activeHeadId;
  while (id) {
    if (result.has(id)) break;
    result.add(id);
    id = byId.get(id)?.parentId ?? null;
  }
  return result;
}

export function branchAt(canvas: ConversationCanvas, parentId: string | null): ConversationCanvas {
  if (parentId !== null && !canvas.nodes.some((node) => node.id === parentId)) {
    throw new Error(`Cannot branch from unknown node ${parentId}`);
  }
  return { ...canvas, activeHeadId: parentId };
}

export function appendCanvasMessage(
  canvas: ConversationCanvas,
  message: Omit<CanvasMessage, "parentId"> & { parentId?: string | null },
): ConversationCanvas {
  if (message.transient) return canvas;
  const parentId = message.parentId === undefined ? canvas.activeHeadId : message.parentId;
  if (parentId !== null && !canvas.nodes.some((node) => node.id === parentId)) {
    throw new Error(`Cannot append to unknown node ${parentId}`);
  }
  if (canvas.nodes.some((node) => node.id === message.id)) return canvas;
  return { ...canvas, nodes: [...canvas.nodes, { ...message, parentId }], activeHeadId: message.id };
}

export function createDocument(
  canvas: ConversationCanvas,
  input: { id: string; title: string; markdown: string; now?: string; transient?: boolean },
): ConversationCanvas {
  if (input.transient) throw new Error("Transient meeting evidence cannot become a document");
  const now = input.now ?? new Date().toISOString();
  const version: DocumentVersion = { id: `${input.id}:v1`, documentId: input.id, version: 1, markdown: input.markdown, createdAt: now };
  const doc: CanvasDocument = { id: input.id, title: input.title, versions: [version], createdAt: now, updatedAt: now };
  return { ...canvas, documents: [...canvas.documents.filter((d) => d.id !== input.id), doc] };
}

export function saveDocumentVersion(
  canvas: ConversationCanvas,
  documentId: string,
  markdown: string,
  now = new Date().toISOString(),
): ConversationCanvas {
  const document = canvas.documents.find((item) => item.id === documentId);
  if (!document) throw new Error(`Cannot version unknown document ${documentId}`);
  const version = document.versions.length + 1;
  const next: DocumentVersion = { id: `${documentId}:v${version}`, documentId, version, markdown, createdAt: now };
  return {
    ...canvas,
    documents: canvas.documents.map((item) => item.id === documentId
      ? { ...item, versions: [...item.versions, next], updatedAt: now }
      : item),
  };
}

export function placeDocument(
  canvas: ConversationCanvas,
  documentId: string,
  versionId: string,
  orderOrOptions: number | { order?: number; beforeMessageId?: string | null; slot?: DocumentPlacement["slot"] } = canvas.placements.length,
): ConversationCanvas {
  const doc = canvas.documents.find((item) => item.id === documentId);
  if (!doc || !doc.versions.some((version) => version.id === versionId)) throw new Error("Unknown document version");
  const options = typeof orderOrOptions === "number" ? { order: orderOrOptions } : orderOrOptions;
  const placement: DocumentPlacement = { id: `${documentId}:${versionId}`, documentId, versionId, order: options.order ?? canvas.placements.length, beforeMessageId: options.beforeMessageId, slot: options.slot };
  return { ...canvas, placements: [...canvas.placements.filter((item) => item.id !== placement.id), placement] };
}

export function removeDocumentPlacement(canvas: ConversationCanvas, placementId: string): ConversationCanvas {
  return { ...canvas, placements: canvas.placements.filter((placement) => placement.id !== placementId) };
}

export function moveDocumentPlacement(
  canvas: ConversationCanvas,
  placementId: string,
  direction: "before" | "after",
): ConversationCanvas {
  const placements = [...canvas.placements].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  const index = placements.findIndex((placement) => placement.id === placementId);
  const nextIndex = direction === "before" ? index - 1 : index + 1;
  if (index < 0 || nextIndex < 0 || nextIndex >= placements.length) return canvas;
  [placements[index], placements[nextIndex]] = [placements[nextIndex], placements[index]];
  return { ...canvas, placements: placements.map((placement, order) => ({ ...placement, order })) };
}

/** Move a pinned document to an exact semantic request position. */
export function moveDocumentPlacementTo(
  canvas: ConversationCanvas,
  placementId: string,
  target: DocumentPlacementTarget,
  order: number,
): ConversationCanvas {
  const placements = [...canvas.placements].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  const placement = placements.find((item) => item.id === placementId);
  if (!placement) return canvas;
  const remaining = placements.filter((item) => item.id !== placementId);
  remaining.splice(Math.max(0, Math.min(order, remaining.length)), 0, {
    ...placement,
    beforeMessageId: target.beforeMessageId,
    slot: target.slot,
  });
  return {
    ...canvas,
    placements: remaining.map((item, nextOrder) => ({ ...item, order: nextOrder })),
  };
}

export function setDocumentPlacementSlot(
  canvas: ConversationCanvas,
  placementId: string,
  slot: { beforeMessageId?: string | null; slot?: DocumentPlacement["slot"] },
): ConversationCanvas {
  return { ...canvas, placements: canvas.placements.map((placement) => placement.id === placementId ? { ...placement, beforeMessageId: slot.beforeMessageId, slot: slot.slot } : placement) };
}

export function activeBranch(canvas: ConversationCanvas): CanvasMessage[] {
  const ancestry = activeAncestry(canvas);
  return canvas.nodes.filter((node) => ancestry.has(node.id) && !node.transient).sort((a, b) => {
    const depth = (candidate: CanvasMessage): number => {
      let count = 0; let id = candidate.parentId;
      while (id) { count++; id = canvas.nodes.find((item) => item.id === id)?.parentId ?? null; }
      return count;
    };
    return depth(a) - depth(b);
  });
}
