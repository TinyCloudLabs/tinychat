// TC-3195: Share on a recording (approved mock, screens 1 and 2). The owner picks what to include and how long the
// link can be opened, then gets the link to copy or send. The link exists only in this sheet's state: closing the
// sheet forgets it, and the owner's record keeps no link, key or token (sentShares.ts).
import { useEffect, useState, useSyncExternalStore } from "react";
import { AudioLinesIcon, CheckIcon, CopyIcon, LinkIcon, Link2OffIcon, Share2Icon, UsersIcon } from "lucide-react";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { Button } from "@/components/ui/button";
import { ResponsiveSheet, ResponsiveSheetBody, ResponsiveSheetFooter } from "@/components/ui/responsive-sheet";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { copyText } from "@/lib/copyText";
import { meetingAudioFrom } from "@/lib/connectors/meetingExplorer";
import { transcriptKvKey } from "@/lib/connectors/connectorStore";
import { useShowHiddenFeatures } from "@/lib/hiddenFeatures";
import { includesLabel, type RecordingShareDisplay, type SharedPart } from "@/lib/nativeShares/display";
import { countShareClaims, createShare, publishShareLink } from "@/lib/nativeShares/sdk";
import { sentShareRecord, sentShares, sharesOf, stopSharingRecording, useRecordingShared, type SentRecordingShare } from "@/lib/nativeShares/sentShares";
import { cn } from "@/lib/utils";
import { voiceNoteTranscriptLocator } from "@/lib/voiceNotes/voiceNoteCommits";
import { voiceNoteAudioKvKey, VOICE_NOTE_SOURCE } from "@/lib/voiceNotes/voiceNoteStore";
import { formatSpokenDuration, shortDate } from "../library/formatters";
import { libraryKind } from "../library/libraryKinds";
import type { LibraryItem } from "../library/LibraryRow";
import { openedByText, shareItemLine } from "./shareCopy";

const DAY_MS = 86_400_000;
/** Access ends 30 days after Create link (or sooner, once the owner stops sharing), whichever link window was picked. */
const ACCESS_MS = 30 * DAY_MS;
const SHEET_DESCRIPTION = "Anyone you send the link to can open it after they sign in. It’s added to their Library.";
const WINDOWS = [
  { value: "1", label: "1 day" },
  { value: "7", label: "7 days" },
  { value: "30", label: "30 days" },
] as const;
type WindowDays = (typeof WINDOWS)[number]["value"];
const COPIED_MS = 1500;

/** What a recording can share: its transcript (if stored) and its audio (if stored in the space). */
export interface ShareableRecording {
  item: LibraryItem;
  title: string;
  metadata: Record<string, unknown> | null;
  hasTranscript: boolean;
}

/** The audio base in the space, or null when the space holds none (on a phone only, pasted, transcript only). */
export function shareAudioBase(recording: ShareableRecording): string | null {
  const { item, metadata } = recording;
  if (item.onPhone || metadata === null) return null;
  if (item.source === VOICE_NOTE_SOURCE) {
    const audio = metadata.audio as { stored?: unknown } | undefined;
    return item.metadata?.capture === "pasted" || audio?.stored === false || Object.keys(metadata).length === 0 ? null : voiceNoteAudioKvKey(item.sourceId);
  }
  const audio = meetingAudioFrom(metadata);
  return audio.status === "stored" ? audio.base : null;
}

/** The exact transcript key: a voice note's committed transcript body, a meeting's transcript. */
async function shareTranscriptKey(tcw: TinyCloudWeb, item: LibraryItem): Promise<string | null> {
  if (item.source !== VOICE_NOTE_SOURCE) return transcriptKvKey(item.source, item.sourceId);
  return (await voiceNoteTranscriptLocator(tcw, item.sourceId)).bodyKey;
}

function Checkbox(props: { label: string; sub: string; checked: boolean; disabled: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label className={cn("flex min-h-11 items-center gap-3", props.disabled && "opacity-50")}>
      <input type="checkbox" className="peer sr-only" checked={props.checked} disabled={props.disabled} onChange={(event) => props.onChange(event.target.checked)} />
      <span aria-hidden="true" className={cn("flex size-5 shrink-0 items-center justify-center rounded-[5px] border peer-focus-visible:ring-2 peer-focus-visible:ring-ring",
        props.checked ? "border-primary bg-primary text-primary-foreground" : "border-input")}>
        {props.checked && <CheckIcon className="size-3.5 [stroke-width:3]" />}
      </span>
      <span className="flex flex-col"><span className="text-body">{props.label}</span><span className="text-meta text-muted-foreground">{props.sub}</span></span>
    </label>
  );
}

function ItemCard(props: { title: string; sub: string }) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-border p-3">
      <span aria-hidden="true" className="flex size-9 shrink-0 items-center justify-center rounded-md bg-surface-2 text-muted-foreground"><AudioLinesIcon className="size-5" /></span>
      <span className="flex min-w-0 flex-1 flex-col"><span className="text-body font-medium [overflow-wrap:anywhere]">{props.title}</span><span className="text-meta text-muted-foreground">{props.sub}</span></span>
    </div>
  );
}

type Phase = "choose" | "creating" | "ready" | "stopping";

export function ShareRecordingSheet(props: { tcw: TinyCloudWeb; recording: ShareableRecording; open: boolean; onOpenChange: (open: boolean) => void; now?: () => Date }) {
  const { tcw, recording } = props;
  const now = props.now ?? (() => new Date());
  const audioBase = shareAudioBase(recording);
  const records = useSyncExternalStore(sentShares.subscribe, sentShares.snapshot, sentShares.snapshot).records;
  const live = sharesOf(records, recording.item.id);
  const [phase, setPhase] = useState<Phase>("choose");
  // The link, while this sheet is open. Never stored.
  const [link, setLink] = useState<string | null>(null);
  const [parts, setParts] = useState<Record<SharedPart, boolean>>({ transcript: recording.hasTranscript, audio: audioBase !== null });
  const [days, setDays] = useState<WindowDays>("7");
  const [error, setError] = useState<string | null>(null);
  const [openedBy, setOpenedBy] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!props.open) {
      setLink(null);
      setError(null);
      setCopied(false);
      setOpenedBy(null);
      return;
    }
    setPhase(live.length > 0 ? "ready" : "choose");
    setParts({ transcript: recording.hasTranscript, audio: audioBase !== null });
    // Only on opening: the live shares change under the sheet when a link is made.
  }, [props.open]);

  const shown = phase === "ready" || phase === "stopping";
  const liveCids = live.map((share) => share.id).join("\n");
  useEffect(() => {
    if (!props.open || !shown || live.length === 0) return;
    let active = true;
    void Promise.all(live.map((share) => countShareClaims(tcw, share.rootCid))).then((counts) => {
      if (active) setOpenedBy(counts.some((count) => count === null) ? null : counts.reduce<number>((sum, count) => sum + (count ?? 0), 0));
    }).catch(() => active && setOpenedBy(null));
    return () => {
      active = false;
    };
  }, [props.open, shown, liveCids, tcw]);

  const includes = (["transcript", "audio"] as const).filter((part) => parts[part]);
  const item = recording.item;
  const display: RecordingShareDisplay = {
    title: recording.title,
    recordedAt: new Date(item.startedAt ?? now().toISOString()).toISOString(),
    durationSeconds: item.durationSecs,
    includes,
    source: libraryKind(item.source) === "note" ? "voice-note" : libraryKind(item.source) === "upload" ? "upload" : "meeting",
  };

  const create = async () => {
    setPhase("creating");
    setError(null);
    try {
      const transcriptKey = parts.transcript ? await shareTranscriptKey(tcw, item) : null;
      const audioPath = parts.audio && audioBase ? `${audioBase}/` : null;
      const paths = [...(transcriptKey ? [transcriptKey] : []), ...(audioPath ? [audioPath] : [])];
      const sharedIncludes: SharedPart[] = [...(transcriptKey ? (["transcript"] as const) : []), ...(audioPath ? (["audio"] as const) : [])];
      if (paths.length === 0) throw new Error("nothing to share");
      const started = now();
      const linkExpiresAt = new Date(started.getTime() + Number(days) * DAY_MS);
      const share = await createShare(tcw, paths, new Date(started.getTime() + ACCESS_MS));
      // Recorded before the link exists, so Stop sharing always reaches a share someone could open.
      const record = sentShareRecord({ rootCid: share.rootCid, recordingId: item.id, paths, linkExpiresAt: linkExpiresAt.toISOString(), accessExpiresAt: share.accessExpiresAt, now: started });
      await sentShares.put(tcw, record);
      let published: { link: string; id: string; expiresAt: string };
      try {
        published = await publishShareLink({ token: share.token, display: { ...display, includes: sharedIncludes }, linkExpiresAt });
      } catch (caught) {
        // No link was made, so nobody holds this share's token: the record has nothing to stop.
        await sentShares.remove(tcw, record.id).catch(() => undefined);
        throw caught;
      }
      await sentShares.put(tcw, { ...record, linkId: published.id, linkExpiresAt: new Date(published.expiresAt).toISOString() }).catch(() => undefined);
      setLink(published.link);
      setPhase("ready");
    } catch {
      setError("Couldn’t create the link. Try again.");
      setPhase("choose");
    }
  };

  const stop = async () => {
    setPhase("stopping");
    setError(null);
    try {
      await stopSharingRecording(tcw, item.id);
      props.onOpenChange(false);
    } catch {
      setError("Couldn’t stop sharing. Try again.");
      setPhase("ready");
    }
  };

  const copy = async () => {
    if (!link || !(await copyText(link))) return;
    setCopied(true);
    window.setTimeout(() => setCopied(false), COPIED_MS);
  };
  const canShare = link !== null && typeof navigator !== "undefined" && typeof navigator.share === "function";
  const latest: SentRecordingShare | undefined = live[0];
  // One access end everywhere: the stored per-share end once a share exists, before that what Create link would sign.
  const accessEnds = shortDate(latest ? new Date(latest.accessExpiresAt) : new Date(now().getTime() + ACCESS_MS), now());
  const sharedParts = latest ? (latest.paths.length === 2 ? (["transcript", "audio"] as const) : latest.paths[0]!.endsWith("/") ? (["audio"] as const) : (["transcript"] as const)) : includes;

  if (shown) {
    return (
      <ResponsiveSheet
        open={props.open}
        onOpenChange={props.onOpenChange}
        dismissible={phase !== "stopping"}
        title="Share recording"
        description={link ? "Send this link to the people you want to share with. They’ll sign in to open it." : SHEET_DESCRIPTION}
        contentProps={{ "data-testid": "share-sheet", "data-phase": "ready" }}
      >
        <ResponsiveSheetBody>
          <div className="flex flex-col gap-4">
            <ItemCard title={recording.title} sub={includesLabel(sharedParts)} />
            {link && (
              <div className="flex items-center gap-2 rounded-md border border-input bg-background py-1 pl-3 pr-1">
                <LinkIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate font-mono text-[13px]" data-testid="share-link">{link.replace(/^https:\/\//, "")}</span>
                <Button type="button" variant="ghost" className="h-9 px-3" onClick={() => void copy()}><CopyIcon aria-hidden="true" />{copied ? "Copied" : "Copy"}</Button>
              </div>
            )}
            {latest && (
              <div className="flex flex-col gap-1 rounded-lg bg-surface-2 p-3">
                {openedBy !== null && <p className="flex items-center gap-2 text-callout"><UsersIcon aria-hidden="true" className="size-4 text-muted-foreground" /><span>{openedByText(openedBy)}</span></p>}
                <p className="text-meta text-muted-foreground">The link can be opened until {shortDate(new Date(latest.linkExpiresAt), now())}. People who opened it can see it until {accessEnds}, unless you stop sharing sooner.</p>
              </div>
            )}
            {error && <p role="alert" className="text-meta text-[var(--red-text)]">{error}</p>}
            <Button type="button" variant="ghost" className="-ml-2 h-11 self-start px-2 text-[color:var(--red-text)] hover:bg-accent hover:text-[color:var(--red-text)]" disabled={phase === "stopping"} onClick={() => void stop()}>
              <Link2OffIcon aria-hidden="true" />Stop sharing
            </Button>
          </div>
        </ResponsiveSheetBody>
        {/* Reopened later, the link is gone (never kept): the status view has no link, Copy or Share. */}
        {link && (
          <ResponsiveSheetFooter>
            {canShare && <Button type="button" variant="outline" className="flex-1 lg:flex-none" onClick={() => void navigator.share({ url: link }).catch(() => undefined)}><Share2Icon aria-hidden="true" />Share…</Button>}
            <Button type="button" className="flex-1 lg:flex-none" onClick={() => void copy()}><CopyIcon aria-hidden="true" />{copied ? "Copied" : "Copy link"}</Button>
          </ResponsiveSheetFooter>
        )}
      </ResponsiveSheet>
    );
  }

  return (
    <ResponsiveSheet
      open={props.open}
      onOpenChange={props.onOpenChange}
      dismissible={phase !== "creating"}
      title="Share recording"
      description={SHEET_DESCRIPTION}
      contentProps={{ "data-testid": "share-sheet", "data-phase": "choose" }}
    >
      <ResponsiveSheetBody>
        <div className="flex flex-col gap-4">
          <ItemCard title={recording.title} sub={shareItemLine(display, now())} />
          <fieldset className="flex flex-col">
            <legend className="mb-1 text-meta font-semibold text-muted-foreground">Include</legend>
            <Checkbox label="Transcript" sub="Speakers and timestamps" checked={parts.transcript} disabled={!recording.hasTranscript || phase === "creating"} onChange={(checked) => setParts((current) => ({ ...current, transcript: checked }))} />
            <Checkbox label="Audio" sub={item.durationSecs !== null ? formatSpokenDuration(item.durationSecs) : "Audio"} checked={parts.audio} disabled={audioBase === null || phase === "creating"} onChange={(checked) => setParts((current) => ({ ...current, audio: checked }))} />
          </fieldset>
          <div className="flex flex-col gap-2">
            <p className="text-meta font-semibold text-muted-foreground" id="share-window">Link can be opened for</p>
            <SegmentedControl aria-label="Link can be opened for" value={days} onValueChange={setDays} options={WINDOWS} />
            <p className="text-meta text-muted-foreground">Anyone who opens it in that time can see it until {accessEnds}, unless you stop sharing sooner.</p>
          </div>
          {error && <p role="alert" className="text-meta text-[var(--red-text)]">{error}</p>}
        </div>
      </ResponsiveSheetBody>
      <ResponsiveSheetFooter>
        <Button type="button" className="w-full lg:w-auto" disabled={includes.length === 0 || phase === "creating"} onClick={() => void create()}>Create link</Button>
      </ResponsiveSheetFooter>
    </ResponsiveSheet>
  );
}

/**
 * The Share button on a recording's detail (mock: the page header's share icon). Behind Settings → "Show hidden
 * features" until sharing is turned on; a recording already shared keeps it, so Stop sharing stays reachable.
 */
export function ShareRecordingButton(props: { tcw: TinyCloudWeb; recording: ShareableRecording }) {
  const [open, setOpen] = useState(false);
  const showHidden = useShowHiddenFeatures();
  const shared = useRecordingShared(props.recording.item.id);
  if (!showHidden && !shared) return null;
  if (!props.recording.hasTranscript && shareAudioBase(props.recording) === null) return null;
  return (
    <>
      <button type="button" aria-label="Share" data-testid="share-recording" onClick={() => setOpen(true)}
        className="tap-transparent flex size-11 items-center justify-center rounded-full text-foreground hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring fine:size-9">
        <Share2Icon aria-hidden="true" className="size-5" />
      </button>
      <ShareRecordingSheet tcw={props.tcw} recording={props.recording} open={open} onOpenChange={setOpen} />
    </>
  );
}
