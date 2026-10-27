// Renaming a recording from a list row or a note header. The provider holds the signed-in space;
// without one (a surface with no space) nothing offers a rename.
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { PencilIcon } from "lucide-react";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { readUserTitledIds, renameRecording } from "@/lib/recordingTitle";
import { normalizeRecordingTitle } from "@/lib/recordingTitleMeta";
import { captureEvents } from "../../captureEvents";
import { RecordingTitleEditor } from "./RecordingTitleEditor";
import { RECORDING_RENAME_FAILED, recordingRenameLabel } from "./recordingRenameStrings";

export interface RenamableRecording { id: string; source: string; sourceId: string; onPhone?: true }

type Rename = (recording: RenamableRecording, title: string) => Promise<boolean>;
interface RenameValue { rename: Rename; userTitled: ReadonlySet<string> }
const RenameContext = createContext<RenameValue | null>(null);
const NONE: ReadonlySet<string> = new Set();

export function RecordingRenameProvider({ tcw, children }: { tcw: TinyCloudWeb; children: ReactNode }) {
  // The rows with a name of their own: a voice note's row is titled by its own words unless the user named it.
  // Read here, apart from the Library's list read.
  const [userTitled, setUserTitled] = useState<ReadonlySet<string>>(NONE);
  const [reads, setReads] = useState(0);
  useEffect(() => captureEvents.on("library-changed", () => setReads((n) => n + 1)), []);
  useEffect(() => {
    let live = true;
    void readUserTitledIds(tcw).then((ids) => { if (live) setUserTitled(ids); })
      .catch(() => { /* rows keep the titles they show */ });
    return () => { live = false; };
  }, [tcw, reads]);
  const rename = useCallback<Rename>(async (recording, title) => {
    const result = await renameRecording(tcw, recording.id, title);
    if (!result.ok) {
      console.warn("Recording rename failed", result.error);
      return false;
    }
    captureEvents.emit("library-changed", { source: recording.source, sourceId: recording.sourceId });
    return true;
  }, [tcw]);
  const value = useMemo(() => ({ rename, userTitled }), [rename, userTitled]);
  return <RenameContext.Provider value={value}>{children}</RenameContext.Provider>;
}

/** The title the user typed for a row, or null: the caller shows its usual title. */
export function useUserTitle(item: { id: string; title: string | null }): string | null {
  const ctx = useContext(RenameContext);
  return ctx?.userTitled.has(item.id) && item.title ? item.title : null;
}

export interface RecordingTitleEdit {
  editing: boolean;
  /** What the editor opens with: the title as shown. */
  current: string;
  failed: boolean;
  start: () => void;
  save: (title: string) => void;
  cancel: () => void;
}

/** The edit state of one recording's title; null when it cannot be renamed here (no space, or not in the space yet). */
export function useRecordingTitleEdit(recording: RenamableRecording | null, current: string): RecordingTitleEdit | null {
  const rename = useContext(RenameContext)?.rename ?? null;
  const [editing, setEditing] = useState(false);
  const [failed, setFailed] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const id = recording?.id;
  const state = useMemo<RecordingTitleEdit | null>(() => {
    if (!rename || !recording || recording.onPhone) return null;
    return {
      editing,
      current: draft ?? current,
      failed,
      start: () => { setFailed(false); setDraft(null); setEditing(true); },
      cancel: () => { setFailed(false); setDraft(null); setEditing(false); },
      save: (value) => {
        // An unchanged title is not a rename: it would pin an automatic title as the user's.
        if (normalizeRecordingTitle(value) === normalizeRecordingTitle(current)) { setEditing(false); setDraft(null); return; }
        setEditing(false);
        setDraft(null);
        void rename(recording, value).then((ok) => {
          if (ok) return;
          setDraft(value);
          setFailed(true);
          setEditing(true);
        });
      },
    };
    // `id` stands for the recording: a row's item object changes with every list read.
  }, [rename, id, recording?.onPhone, editing, failed, draft, current]);
  return state;
}

/** The inline editor, with its failure line. */
export function RecordingTitleEditField({ edit, className }: { edit: RecordingTitleEdit; className?: string }) {
  return (
    <div className={cn("flex min-w-0 flex-1 flex-col", className)} data-testid="recording-title-edit">
      <RecordingTitleEditor key={edit.current} initial={edit.current} onSave={edit.save} onCancel={edit.cancel} />
      {edit.failed && <p role="alert" className="px-1 text-meta text-destructive">{RECORDING_RENAME_FAILED}</p>}
    </div>
  );
}

/** The pencil, 44 px to touch. */
export function RenameRecordingButton({ edit, className }: { edit: RecordingTitleEdit; className?: string }) {
  const label = recordingRenameLabel(edit.current);
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      aria-label={label}
      title={label}
      data-testid="recording-rename"
      onClick={edit.start}
      className={cn("shrink-0 text-muted-foreground hover:text-foreground", className)}
    >
      <PencilIcon />
    </Button>
  );
}

/** A note header's heading with its pencil beside it; the editor replaces it while editing. */
export function TitleWithRename({ edit, heading }: { edit: RecordingTitleEdit | null; heading: ReactNode }) {
  if (!edit) return <>{heading}</>;
  return (
    <div className="flex min-w-0 flex-1 items-start gap-1">
      {edit.editing ? (
        <>
          {/* The heading stays for assistive technology and the dialog's label. */}
          <div className="sr-only">{heading}</div>
          <RecordingTitleEditField edit={edit} />
        </>
      ) : (
        <>
          <div className="min-w-0 flex-1">{heading}</div>
          <RenameRecordingButton edit={edit} />
        </>
      )}
    </div>
  );
}

/** The classic note header's title and meta line, with the rename pencil (beside the title; beside the meta line under a page header that already shows the title). */
export function NoteHeaderTitle({ item, title, pushed, meta }: { item: RenamableRecording; title: string; pushed: boolean; meta: ReactNode }) {
  const edit = useRecordingTitleEdit(item, title);
  const metaLine = <p className="tnum text-meta text-muted-foreground">{meta}</p>;
  if (!pushed) {
    return <>
      <TitleWithRename edit={edit} heading={<h2 className="font-display text-title-1 [overflow-wrap:anywhere]">{title}</h2>} />
      {metaLine}
    </>;
  }
  if (edit?.editing) return <>{<RecordingTitleEditField edit={edit} />}{metaLine}</>;
  return <div className="flex items-center gap-1"><div className="min-w-0 flex-1">{metaLine}</div>{edit && <RenameRecordingButton edit={edit} />}</div>;
}
