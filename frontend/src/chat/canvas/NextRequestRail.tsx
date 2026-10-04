import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { GripVerticalIcon } from "lucide-react";
import {
  assembleRequestContext,
  getRequestAttempt,
  resetRequestAttempt,
  subscribeRequestAttempt,
  type RequestContextEntry,
} from "./requestContext";
import type { ConversationCanvas, DocumentPlacementTarget } from "./model";

interface NextRequestRailProps {
  canvas: ConversationCanvas;
  newUserMessage?: string;
  onReorder?: (placementId: string, target: DocumentPlacementTarget, order: number) => void;
  disabled?: boolean;
}

function entryKey(entry: RequestContextEntry, index: number): string {
  return entry.placementId ?? entry.sourceId ?? `${entry.kind}-${index}`;
}

export function NextRequestRail({
  canvas,
  newUserMessage = "",
  onReorder,
  disabled = false,
}: NextRequestRailProps) {
  const subscribe = useMemo(() => (listener: () => void) => subscribeRequestAttempt(canvas.threadId, listener), [canvas.threadId]);
  const snapshot = useMemo(() => () => getRequestAttempt(canvas.threadId), [canvas.threadId]);
  const attempt = useSyncExternalStore(subscribe, snapshot, snapshot);
  const draft = useMemo(() => assembleRequestContext({ canvas, newUserMessage }), [canvas, newUserMessage]);
  const previousDraft = useRef(newUserMessage);
  const [pickedPlacementId, setPickedPlacementId] = useState<string | null>(null);
  const [activeDropIndex, setActiveDropIndex] = useState<number | null>(null);
  const [announcement, setAnnouncement] = useState("");

  useEffect(() => () => resetRequestAttempt(canvas.threadId), [canvas.threadId]);
  useEffect(() => {
    if (previousDraft.current !== newUserMessage && attempt.state === "sent") resetRequestAttempt(canvas.threadId);
    previousDraft.current = newUserMessage;
  }, [attempt.state, canvas.threadId, newUserMessage]);
  useEffect(() => {
    if (pickedPlacementId && !canvas.placements.some((placement) => placement.id === pickedPlacementId)) {
      setPickedPlacementId(null);
    }
  }, [canvas.placements, pickedPlacementId]);

  const entries = useMemo<RequestContextEntry[]>(() => {
    if (attempt.state === "draft") return draft.entries.filter((entry) => entry.content.length > 0);
    return (attempt.payload ?? draft.messages)
      .filter((message) => message.content.length > 0)
      .map((message, index) => ({ ...message, kind: "prelude", sourceId: `sent-${index}` }));
  }, [attempt.payload, attempt.state, draft]);
  const leadingPreludeCount = entries.findIndex((entry) => entry.kind !== "prelude");
  const firstDropIndex = leadingPreludeCount < 0 ? entries.length : leadingPreludeCount;
  const canReorder = attempt.state === "draft" && !disabled && canvas.placements.length > 0;

  const targetForGap = (gapIndex: number, movingId: string): { target: DocumentPlacementTarget; order: number } => {
    const nextAnchor = entries.slice(gapIndex).find((entry) => entry.kind === "message" || entry.kind === "new-user");
    const target: DocumentPlacementTarget = nextAnchor?.kind === "message" && nextAnchor.sourceId
      ? { beforeMessageId: nextAnchor.sourceId, slot: "before" }
      : { slot: "next-user" };
    const order = entries.slice(0, gapIndex).filter((entry) => entry.kind === "document" && entry.placementId !== movingId).length;
    return { target, order };
  };

  const labelForGap = (gapIndex: number, movingId: string): string => {
    const nextEntry = entries.slice(gapIndex).find((entry) => entry.placementId !== movingId && entry.kind !== "prelude");
    if (nextEntry?.kind === "document") return `before ${nextEntry.documentTitle ?? "document"}`;
    if (nextEntry?.kind === "message") return `before ${nextEntry.role} message`;
    return "before your next message";
  };

  const placeAt = (placementId: string, gapIndex: number) => {
    const { target, order } = targetForGap(gapIndex, placementId);
    const label = labelForGap(gapIndex, placementId);
    onReorder?.(placementId, target, order);
    setAnnouncement(`Moved document ${label}.`);
    setPickedPlacementId(null);
    setActiveDropIndex(null);
  };

  const moveWithKeyboard = (placementId: string, entryIndex: number, key: string) => {
    const lastMovableIndex = entries.at(-1)?.kind === "new-user" ? entries.length - 2 : entries.length - 1;
    if (key === "ArrowUp" && entryIndex > firstDropIndex) placeAt(placementId, entryIndex - 1);
    if (key === "ArrowDown" && entryIndex < lastMovableIndex) placeAt(placementId, entryIndex + 2);
    if (key === "Home") placeAt(placementId, firstDropIndex);
    if (key === "End") placeAt(placementId, entries.at(-1)?.kind === "new-user" ? entries.length - 1 : entries.length);
  };

  const renderDropTarget = (gapIndex: number) => {
    if (!canReorder || !pickedPlacementId || gapIndex < firstDropIndex) return null;
    const currentEntryIndex = entries.findIndex((entry) => entry.placementId === pickedPlacementId);
    if (gapIndex === currentEntryIndex || gapIndex === currentEntryIndex + 1) return null;
    const currentPlacement = [...canvas.placements]
      .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
      .find((placement) => placement.id === pickedPlacementId);
    const currentOrder = [...canvas.placements]
      .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
      .findIndex((placement) => placement.id === pickedPlacementId);
    const candidate = targetForGap(gapIndex, pickedPlacementId);
    const sameTarget = currentPlacement?.slot === candidate.target.slot
      && currentPlacement.beforeMessageId === candidate.target.beforeMessageId
      && currentOrder === candidate.order;
    if (sameTarget) return null;
    const label = labelForGap(gapIndex, pickedPlacementId);
    return (
      <li key={`drop-${gapIndex}`} role="presentation">
        <button
          type="button"
          className={`my-1 flex min-h-11 w-full items-center gap-2 rounded-md border border-dashed px-2 text-left text-[11px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${activeDropIndex === gapIndex ? "border-primary bg-primary/10 text-foreground" : "border-border text-muted-foreground hover:border-primary/70 hover:bg-muted"}`}
          aria-label={`Place selected document ${label}`}
          onClick={() => placeAt(pickedPlacementId, gapIndex)}
          onDragEnter={(event) => { event.preventDefault(); setActiveDropIndex(gapIndex); }}
          onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "move"; }}
          onDrop={(event) => {
            event.preventDefault();
            const placementId = event.dataTransfer.getData("text/x-tinychat-placement") || pickedPlacementId;
            if (placementId) placeAt(placementId, gapIndex);
          }}
        >
          <span className="h-px flex-1 bg-border" />
          <span>Place {label}</span>
          <span className="h-px flex-1 bg-border" />
        </button>
      </li>
    );
  };

  return (
    <section aria-label="Next Request" className="mb-4 rounded-md border border-border bg-muted/30 p-2">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="font-medium">Next Request</h3>
        <span className="rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">{attempt.state}</span>
      </div>
      {canReorder && (
        <p className="mb-2 text-[11px] leading-4 text-muted-foreground">
          Drag documents into place, or select one to reveal touch-friendly drop points. Arrow keys also move a focused document.
        </p>
      )}
      <ol className="space-y-1">
        {entries.map((entry, index) => {
          const dropTarget = renderDropTarget(index);
          if (entry.kind === "document" && entry.placementId) {
            const selected = pickedPlacementId === entry.placementId;
            return [
              dropTarget,
              <li key={entryKey(entry, index)}>
                <button
                  type="button"
                  draggable={canReorder}
                  disabled={!canReorder}
                  aria-pressed={selected}
                  aria-label={`Move ${entry.documentTitle ?? "document"}, version ${entry.documentVersion ?? "unknown"}. Drag, select a drop point, or use arrow keys.`}
                  className={`flex min-h-11 w-full items-start gap-2 rounded-md border px-2 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${selected ? "border-primary bg-primary/10" : "border-primary/40 bg-background hover:border-primary"}`}
                  onClick={() => setPickedPlacementId(selected ? null : entry.placementId!)}
                  onKeyDown={(event) => {
                    if (["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) {
                      event.preventDefault();
                      moveWithKeyboard(entry.placementId!, index, event.key);
                    }
                  }}
                  onDragStart={(event) => {
                    event.dataTransfer.effectAllowed = "move";
                    event.dataTransfer.setData("text/x-tinychat-placement", entry.placementId!);
                    setPickedPlacementId(entry.placementId!);
                  }}
                  onDragEnd={() => setActiveDropIndex(null)}
                >
                  <GripVerticalIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0">
                    <span className="block text-[10px] uppercase text-muted-foreground">Document · v{entry.documentVersion}</span>
                    <span className="block truncate font-medium">{entry.documentTitle}</span>
                  </span>
                </button>
              </li>,
            ];
          }
          return [
            dropTarget,
            <li key={entryKey(entry, index)} className="rounded border border-border/60 bg-background px-2 py-1">
              <span className="mr-1 text-[10px] uppercase text-muted-foreground">{entry.role}</span>
              <span className="whitespace-pre-wrap">{entry.content}</span>
            </li>,
          ];
        })}
        {entries.at(-1)?.kind !== "new-user" && renderDropTarget(entries.length)}
      </ol>
      <p className="sr-only" aria-live="polite">{announcement}</p>
    </section>
  );
}
