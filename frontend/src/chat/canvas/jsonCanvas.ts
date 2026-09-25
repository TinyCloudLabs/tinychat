import type { ConversationCanvas } from "./model";
import { sanitizeCanvas } from "../../lib/conversationCanvasStore";

export interface JsonCanvasNode {
  id: string;
  type: "text" | "group";
  x: number;
  y: number;
  width: number;
  height: number;
  text?: string;
  label?: string;
}

export interface JsonCanvasEdge { id: string; fromNode: string; toNode: string; }

export interface JsonCanvasDocument {
  nodes: JsonCanvasNode[];
  edges: JsonCanvasEdge[];
}

/** Portable JSON Canvas 1.0 projection; never used as runtime storage. */
export function toJsonCanvas(canvas: ConversationCanvas): JsonCanvasDocument {
  canvas = sanitizeCanvas(canvas);
  const durableNodes = canvas.nodes.filter((node) => !node.transient);
  const depth = new Map<string, number>();
  const nodeAt = new Map(durableNodes.map((node) => [node.id, node]));
  const getDepth = (id: string): number => {
    const known = depth.get(id);
    if (known !== undefined) return known;
    const node = nodeAt.get(id);
    const value = node?.parentId && nodeAt.has(node.parentId) ? getDepth(node.parentId) + 1 : 0;
    depth.set(id, value);
    return value;
  };
  const groups: JsonCanvasNode[] = [
    { id: "group-conversation", type: "group", x: 0, y: 0, width: 980, height: Math.max(240, durableNodes.length * 180 + 80), label: "Conversation" },
    { id: "group-next-request", type: "group", x: 1020, y: 0, width: 360, height: 260, label: "Next Request" },
    { id: "group-documents", type: "group", x: 0, y: Math.max(300, durableNodes.length * 180 + 120), width: 980, height: Math.max(180, canvas.documents.length * 180 + 80), label: "Documents" },
  ];
  const nodes = durableNodes.map((node, index) => ({
    id: node.id,
    type: "text" as const,
    x: Number.isInteger(node.position?.x) ? node.position!.x : getDepth(node.id) * 320,
    y: Number.isInteger(node.position?.y) ? node.position!.y : index * 180,
    width: 280,
    height: 140,
    text: `${node.role}\n\n${node.content}`,
  }));
  const documentNodes = canvas.documents.flatMap((doc, docIndex) => doc.versions.map((version, versionIndex) => ({
    id: `document-${version.id}`,
    type: "text" as const,
    x: 30 + docIndex * 300,
    y: Math.max(340, durableNodes.length * 180 + 160) + versionIndex * 160,
    width: 260,
    height: 120,
    text: version.markdown,
    label: `${doc.title} v${version.version}`,
  })));
  const edges = durableNodes.flatMap((node) => node.parentId && nodeAt.has(node.parentId)
    ? [{ id: `${node.parentId}->${node.id}`, fromNode: node.parentId, toNode: node.id }]
    : []).concat(documentNodes.map((node) => ({ id: `group-documents->${node.id}`, fromNode: "group-documents", toNode: node.id })));
  return { nodes: [...groups, ...nodes, ...documentNodes], edges };
}

export const exportJsonCanvas = toJsonCanvas;
