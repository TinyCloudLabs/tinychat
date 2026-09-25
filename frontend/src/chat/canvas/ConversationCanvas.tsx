import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuiState } from "@assistant-ui/react";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { applyNodeChanges, Background, Controls, ReactFlow, type Edge, type Node, type NodeChange } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Button } from "@/components/ui/button";
import { getCanvas, promoteLegacyThread, saveCanvas } from "../../lib/conversationCanvasStore";
import {
  activeAncestry,
  branchAt,
  createDocument,
  moveDocumentPlacementTo,
  placeDocument,
  removeDocumentPlacement,
  saveDocumentVersion,
  type ConversationCanvas as CanvasModel,
  normalizeLegacyMessages,
} from "./model";
import { NextRequestRail } from "./NextRequestRail";
import { resetRequestAttempt } from "./requestContext";

interface ConversationCanvasProps {
  tcw: TinyCloudWeb;
  threadId: string;
  editingDisabled?: boolean;
  onSwitchToChat: () => void;
  onCanvasChange?: (canvas: CanvasModel) => void;
}

export function ConversationCanvas({ tcw, threadId, editingDisabled = false, onSwitchToChat, onCanvasChange }: ConversationCanvasProps) {
  const composerDraft = useAuiState((state) => state.composer.text);
  const [canvas, setCanvas] = useState<CanvasModel | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [documentTitle, setDocumentTitle] = useState("Canvas note");
  const [flowNodes, setFlowNodes] = useState<Node[]>([]);

  useEffect(() => {
    let cancelled = false;
    void promoteLegacyThread(tcw, threadId).then((value) => {
      if (!cancelled) setCanvas(value ?? normalizeLegacyMessages([], threadId));
    }).catch((reason) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
    });
    return () => { cancelled = true; };
  }, [tcw, threadId]);

  const update = useCallback((next: CanvasModel, semantic = true) => {
    const branchChanged = canvas?.activeHeadId !== next.activeHeadId;
    if (semantic) resetRequestAttempt(threadId);
    setCanvas(next);
    if (branchChanged) onCanvasChange?.(next);
    void saveCanvas(tcw, next).catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
  }, [canvas?.activeHeadId, onCanvasChange, tcw, threadId]);

  const ancestry = useMemo(() => canvas ? activeAncestry(canvas) : new Set<string>(), [canvas]);
  const nodes = useMemo<Node[]>(() => (canvas?.nodes ?? []).map((node, index) => ({
    id: node.id,
    position: node.position ?? { x: 40 + (index % 3) * 300, y: 40 + Math.floor(index / 3) * 170 },
    data: { label: <div className="max-w-56 text-xs"><div className="mb-1 font-medium capitalize">{node.role}</div><div className="line-clamp-5 whitespace-pre-wrap">{node.content}</div></div> },
    className: ancestry.has(node.id) ? "border-primary ring-2 ring-primary/30" : "border-border",
    style: { width: 260, padding: 12, borderRadius: 10, background: "hsl(var(--card))", color: "hsl(var(--card-foreground))" },
  })), [ancestry, canvas]);
  useEffect(() => setFlowNodes(nodes), [nodes]);
  const edges = useMemo<Edge[]>(() => (canvas?.nodes ?? []).flatMap((node) => node.parentId
    ? [{ id: `${node.parentId}-${node.id}`, source: node.parentId, target: node.id, animated: ancestry.has(node.id) && ancestry.has(node.parentId) }]
    : []), [ancestry, canvas]);

  if (!canvas) return <div className="flex h-full items-center justify-center text-sm text-muted-foreground">{error ?? "Loading canvas…"}</div>;
  const onNodesChange = (changes: NodeChange[]) => setFlowNodes((current) => applyNodeChanges(changes, current));
  const activeNode = canvas.nodes.find((node) => node.id === canvas.activeHeadId);
  const documents = canvas.documents;

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2">
        <div>
          <h2 className="text-sm font-semibold">Conversation Canvas</h2>
          <p className="text-xs text-muted-foreground">Active branch: {activeNode?.role ?? "new"}</p>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={onSwitchToChat}>Return to Chat</Button>
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[1fr_18rem]">
        <div className="min-h-[18rem]">
          <ReactFlow nodes={flowNodes.length > 0 ? flowNodes : nodes} edges={edges} onNodesChange={onNodesChange} onNodeDragStop={(_event, node) => update({ ...canvas, nodes: canvas.nodes.map((item) => item.id === node.id ? { ...item, position: { x: Math.round(node.position.x), y: Math.round(node.position.y) } } : item) }, false)} fitView nodesDraggable={!editingDisabled} nodesConnectable={false} deleteKeyCode={null} aria-label="Conversation branches">
            <Background />
            <Controls />
          </ReactFlow>
        </div>
        <aside className="overflow-y-auto border-t border-border p-3 text-xs lg:border-l lg:border-t-0">
          <NextRequestRail
            canvas={canvas}
            newUserMessage={composerDraft}
            disabled={editingDisabled}
            onReorder={(placementId, target, order) => update(moveDocumentPlacementTo(canvas, placementId, target, order))}
          />
          <div className="mb-4">
            <h3 className="mb-2 font-medium">Branch from message</h3>
            <div className="flex flex-col gap-1">
              {canvas.nodes.map((node) => <Button key={node.id} type="button" disabled={editingDisabled} variant={node.id === canvas.activeHeadId ? "default" : "outline"} size="sm" className="justify-start truncate" onClick={() => update(branchAt(canvas, node.id))}>Continue after {node.role}</Button>)}
            </div>
          </div>
          <div>
            <h3 className="mb-2 font-medium">Documents</h3>
            <input disabled={editingDisabled} value={documentTitle} onChange={(event) => setDocumentTitle(event.currentTarget.value)} placeholder="Document title" className="mb-2 h-9 w-full rounded-md border border-input bg-background px-2" aria-label="Document title" />
            <textarea disabled={editingDisabled} value={draft} onChange={(event) => setDraft(event.currentTarget.value)} placeholder="Markdown document…" className="mb-2 min-h-20 w-full rounded-md border border-input bg-background p-2" aria-label="Markdown document" />
            <Button disabled={editingDisabled || !draft.trim()} type="button" size="sm" className="mb-3 w-full" onClick={() => { if (!draft.trim()) return; const id = `doc-${crypto.randomUUID()}`; update(placeDocument(createDocument(canvas, { id, title: documentTitle.trim() || "Canvas note", markdown: draft }), id, `${id}:v1`)); setDraft(""); setDocumentTitle("Canvas note"); }}>Create document v1</Button>
            {documents.map((doc) => {
              const latest = doc.versions.at(-1)!;
              const pinned = canvas.placements.find((placement) => placement.documentId === doc.id);
              return (
                <div key={doc.id} className="mb-3 rounded-md border border-border p-2">
                  <div className="font-medium">{doc.title}</div>
                  <div className="text-muted-foreground">
                    v{latest.version}{pinned ? ` · pinned v${doc.versions.find((version) => version.id === pinned.versionId)?.version ?? "?"}` : ""}
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1">
                    <Button disabled={editingDisabled || !draft.trim()} type="button" variant="outline" size="sm" onClick={() => update(saveDocumentVersion(canvas, doc.id, draft))}>Save v{latest.version + 1}</Button>
                    {pinned ? (
                      <Button disabled={editingDisabled} type="button" variant="outline" size="sm" onClick={() => update(removeDocumentPlacement(canvas, pinned.id))}>Remove from request</Button>
                    ) : (
                      <Button disabled={editingDisabled} type="button" variant="outline" size="sm" onClick={() => update(placeDocument(canvas, doc.id, latest.id, { slot: "next-user" }))}>Include in request</Button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </aside>
      </div>
    </div>
  );
}
