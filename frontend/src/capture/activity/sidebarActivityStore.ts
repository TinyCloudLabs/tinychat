import type { UploadState } from "@/lib/audioUpload";
import type { NotePipelineView } from "@/lib/voiceNotes/useNotePipeline";
import type { PausedUpload } from "../upload/pausedUpload";
import type { LibraryItem } from "../library/LibraryRow";

/** Capture publishes its current inventory; the sidebar owns the control and survives navigation. */
export interface SidebarActivitySnapshot {
  items: readonly LibraryItem[];
  views: ReadonlyMap<string, NotePipelineView>;
  upload: UploadState | null;
  paused: PausedUpload | null;
  onOpenNote: (id: string) => void;
  onOpenUpload: () => void;
  onContinueUpload: () => void;
  onRetryUpload: () => void;
}

let current: SidebarActivitySnapshot | null = null;
let owner: object | null = null;
const listeners = new Set<() => void>();
const emit = () => { for (const listener of listeners) listener(); };

export const sidebarActivityStore = {
  snapshot: (): SidebarActivitySnapshot | null => current,
  subscribe(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; },
  publish(nextOwner: object, next: SidebarActivitySnapshot): void {
    owner = nextOwner;
    current = next;
    emit();
  },
  clear(previousOwner: object): void {
    if (owner !== previousOwner) return;
    owner = null;
    current = null;
    emit();
  },
};
