// TC-3195: a recording someone shared with you (approved mock, screens 4 and 6). Read only: the transcript and the
// audio are read from the owner's space through the share; once the owner stops sharing, or the access ends, the page
// says so, reads nothing, and offers to remove it from the Library.
import { useEffect, useState, type ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { CalendarXIcon, InfoIcon, Link2OffIcon, RefreshCwIcon } from "lucide-react";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { MeetingAudioPlayer } from "@/chat/MeetingAudioPlayer";
import { Button } from "@/components/ui/button";
import { Empty } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { getAudio } from "@/lib/audio/audioStore";
import type { FirefliesSentence } from "@/lib/connectors/firefliesClient";
import { LINK_DETAILS_CAPTION, quotedTitle } from "@/lib/nativeShares/display";
import {
  firstShareFrom,
  markReceivedShareRevoked,
  receivedShareEnded,
  removeReceivedShare,
  sharedReader,
  sharedRecordingKeys,
  useReceivedShares,
  type ReceivedRecordingShare,
} from "@/lib/nativeShares/receivedShares";
import { isShareRevokedError } from "@/lib/nativeShares/sdk";
import type { TinyCloudKv } from "@/lib/audio/audioStore";
import { Frame, NotePlaybackProvider, transcriptBlocks } from "../library/NoteDetailView";
import { SpeakerLabel } from "../library/SpeakerLabel";
import { TimestampedTranscript } from "../library/TimestampedTranscript";
import { hasSegmentTimes } from "../library/transcriptSegments";
import { shortDate } from "../library/formatters";
import { Sender, SenderAddress } from "./Sender";
import { sharedDetailMeta } from "./shareCopy";

const TOAST_MS = 2400;

export type SharedTranscript =
  | { status: "loading" }
  | { status: "ok"; sentences: FirefliesSentence[] }
  | { status: "absent" }
  | { status: "failed" }
  | { status: "revoked" };

const errorText = (error: unknown): string => {
  if (typeof error === "string") return error;
  if (typeof error !== "object" || error === null) return "";
  const { code, message } = error as { code?: unknown; message?: unknown };
  return `${typeof code === "string" ? code : ""} ${typeof message === "string" ? message : ""}`;
};

/** One read of the shared transcript, mapped to what the page shows. A revoked share is its own answer. */
export async function readSharedTranscript(kv: Pick<TinyCloudKv, "get">, key: string): Promise<SharedTranscript> {
  let res: Awaited<ReturnType<TinyCloudKv["get"]>>;
  try {
    res = await kv.get(key);
  } catch (error) {
    return isShareRevokedError(error) ? { status: "revoked" } : { status: "failed" };
  }
  if (!res.ok) {
    if (isShareRevokedError(res.error)) return { status: "revoked" };
    return /NOT_FOUND/i.test(errorText(res.error)) ? { status: "absent" } : { status: "failed" };
  }
  let payload: unknown = (res.data as { data?: unknown } | undefined)?.data;
  if (typeof payload === "string") {
    try {
      payload = JSON.parse(payload);
    } catch {
      return { status: "absent" };
    }
  }
  if (!Array.isArray(payload)) return { status: "absent" };
  const sentences = payload.filter((s): s is FirefliesSentence => typeof s === "object" && s !== null && typeof (s as { text?: unknown }).text === "string");
  return sentences.length > 0 ? { status: "ok", sentences } : { status: "absent" };
}

function Toast() {
  return (
    <div role="status" className="fixed bottom-[calc(3.5rem+12px)] left-1/2 z-30 -translate-x-1/2 whitespace-nowrap rounded-full bg-primary px-4 py-2 text-callout text-primary-foreground shadow-float lg:bottom-6">
      Added to your Library
    </div>
  );
}

/** Under the heading: the meta line, the caption for what came with the link, and who signed the share. */
function DetailHeading(props: { record: ReceivedRecordingShare; now: Date; firstShare: boolean }) {
  return (
    <>
      <p className="text-callout text-muted-foreground">{sharedDetailMeta(props.record, props.now)}</p>
      <p className="text-meta text-muted-foreground">{LINK_DETAILS_CAPTION}</p>
      <SenderAddress address={props.record.owner.address} firstShare={props.firstShare} />
    </>
  );
}

/** The share can't be read any more (the owner stopped sharing, or the access ended): say why, offer to remove it. */
function Unavailable(props: { record: ReceivedRecordingShare; tcw: TinyCloudWeb; now: Date; pushed: boolean; firstShare: boolean; onRemoved: () => void; testId: string; icon: ReactNode; headline: ReactNode; body: ReactNode }) {
  const [removing, setRemoving] = useState(false);
  const [failed, setFailed] = useState(false);
  const remove = async () => {
    setRemoving(true);
    setFailed(false);
    try {
      await removeReceivedShare(props.tcw, props.record.id);
      props.onRemoved();
    } catch {
      setFailed(true);
      setRemoving(false);
    }
  };
  return (
    <>
      <div className={`${props.pushed ? "" : "-mt-4 "}flex flex-col gap-2`}>
        <DetailHeading record={props.record} now={props.now} firstShare={props.firstShare} />
      </div>
      <div className="flex flex-col items-start gap-2 py-6" data-testid={props.testId}>
        <span aria-hidden="true" className="mb-1 flex size-10 items-center justify-center rounded-lg bg-surface-2 text-muted-foreground [&_svg]:size-5">{props.icon}</span>
        <p className="text-headline">{props.headline}</p>
        <p className="max-w-[34ch] text-callout text-muted-foreground">{props.body}</p>
        <div className="mt-1 flex flex-wrap gap-2">
          <Button type="button" variant="outline" disabled={removing} onClick={() => void remove()}>Remove from Library</Button>
        </div>
        {failed && <p role="alert" className="text-meta text-[var(--red-text)]">Couldn’t remove it. Try again.</p>}
      </div>
    </>
  );
}

export function SharedRecordingDetail(props: { tcw: TinyCloudWeb; recordId: string; pushed: boolean; onBack: () => void; now?: () => Date }) {
  const now = (props.now ?? (() => new Date()))();
  const shares = useReceivedShares();
  const record = shares.records.find((share) => share.id === props.recordId) ?? null;
  const location = useLocation();
  const [toast, setToast] = useState(() => (location.state as { shareAdded?: unknown } | null)?.shareAdded === true);
  const [transcript, setTranscript] = useState<SharedTranscript>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const keys = record ? sharedRecordingKeys(record.paths) : { transcriptKey: null, audioBase: null };
  const revoked = record?.revokedAt !== undefined || transcript.status === "revoked";
  const ended = record !== null && receivedShareEnded(record, now);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(false), TOAST_MS);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const recordId = record?.id;
  const transcriptKey = keys.transcriptKey;
  useEffect(() => {
    if (!record || record.revokedAt || receivedShareEnded(record, now) || !transcriptKey) return;
    let active = true;
    setTranscript({ status: "loading" });
    void sharedReader(props.tcw, record)
      .then((kv) => readSharedTranscript(kv, transcriptKey), (error: unknown): SharedTranscript => isShareRevokedError(error) ? { status: "revoked" } : { status: "failed" })
      .then((read) => {
        if (!active) return;
        setTranscript(read);
        if (read.status === "revoked") void markReceivedShareRevoked(props.tcw, record, new Date()).catch(() => undefined);
      });
    return () => {
      active = false;
    };
    // The record object changes when the list reloads; its id and key decide the read.
  }, [recordId, transcriptKey, props.tcw, attempt]);

  if (shares.state !== "ready" && !record) {
    return (
      <Frame title="Note" pushed={props.pushed} onBack={props.onBack}>
        <div role="status" className="flex flex-col gap-4">
          <span className="sr-only">Loading the note…</span>
          <Skeleton lines={2} className="max-w-sm" />
          <Skeleton lines={5} />
        </div>
      </Frame>
    );
  }
  if (!record) {
    return (
      <Frame title="Note" pushed={props.pushed} onBack={props.onBack}>
        <Empty data-testid="note-absent" title="This note isn’t in your Library." description="It may have been removed from your space." />
      </Frame>
    );
  }

  const title = quotedTitle(record.display.title);
  const sender = <Sender address={record.owner.address} />;
  const firstShare = firstShareFrom(shares, record.owner.address, record.id) === true;
  const audioBase = keys.audioBase;
  const loadAudio = audioBase === null ? null : async (signal: AbortSignal, onProgress: (loaded: number, total: number) => void) => {
    try {
      return await getAudio(await sharedReader(props.tcw, record), audioBase, { signal, onProgress });
    } catch (error) {
      if (isShareRevokedError(error)) {
        setTranscript({ status: "revoked" });
        void markReceivedShareRevoked(props.tcw, record, new Date()).catch(() => undefined);
      }
      throw error;
    }
  };

  return (
    <NotePlaybackProvider>
      <Frame title={title} pushed={props.pushed} onBack={props.onBack}>
        {!props.pushed && <h2 className="font-display text-title-1 [overflow-wrap:anywhere]">{title}</h2>}
        {revoked ? (
          <Unavailable record={record} tcw={props.tcw} now={now} pushed={props.pushed} firstShare={firstShare} onRemoved={props.onBack} testId="shared-revoked" icon={<Link2OffIcon />}
            headline={<>{sender} stopped sharing this recording</>} body={<>It’s no longer available to you. Ask {sender} if you need it again.</>} />
        ) : ended ? (
          <Unavailable record={record} tcw={props.tcw} now={now} pushed={props.pushed} firstShare={firstShare} onRemoved={props.onBack} testId="shared-ended" icon={<CalendarXIcon />}
            headline={`Your access to this recording ended on ${shortDate(new Date(record.accessExpiresAt), now)}`} body={<>Ask {sender} to share it again if you need it.</>} />
        ) : (
          <>
            <header className={`${props.pushed ? "" : "-mt-4 "}flex flex-col gap-2`} data-testid="shared-detail" data-note-id={record.id}>
              <DetailHeading record={record} now={now} firstShare={firstShare} />
              <p className="flex items-center gap-2 text-meta text-muted-foreground"><InfoIcon aria-hidden="true" className="size-4 shrink-0" /><span>In your Library until {shortDate(new Date(record.accessExpiresAt), now)}, unless {sender} stops sharing sooner. Read only.</span></p>
            </header>
            {loadAudio && <MeetingAudioPlayer load={loadAudio} durationSecs={record.display.durationSeconds} />}
            {transcriptKey && (
              <section aria-labelledby="note-transcript" data-testid="note-transcript" className="flex flex-col gap-3">
                <div className="flex min-h-11 items-center">
                  <h2 id="note-transcript" className="flex-1 text-headline">Transcript</h2>
                </div>
                {transcript.status === "ok" ? (
                  <div className="flex max-w-[68ch] flex-col gap-4 [-webkit-touch-callout:default] select-text">
                    {hasSegmentTimes(transcript.sentences) ? <TimestampedTranscript sentences={transcript.sentences} hasAudio={loadAudio !== null} /> : transcriptBlocks(transcript.sentences).map((block, index) => (
                      <div key={index}>
                        {block.speaker && <SpeakerLabel original={block.speaker} />}
                        <p className="whitespace-pre-wrap break-words text-body">{block.text}</p>
                      </div>
                    ))}
                  </div>
                ) : transcript.status === "loading" ? (
                  <div role="status">
                    <span className="sr-only">Loading the transcript…</span>
                    <Skeleton lines={4} />
                  </div>
                ) : transcript.status === "failed" ? (
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-2" data-testid="note-transcript-failed">
                    <p className="text-callout text-muted-foreground">Couldn’t load the transcript.</p>
                    <Button type="button" variant="outline" onClick={() => setAttempt((n) => n + 1)}>
                      <RefreshCwIcon aria-hidden /> Try again
                    </Button>
                  </div>
                ) : (
                  <p className="text-callout text-muted-foreground" data-testid="note-transcript-absent">No transcript stored yet.</p>
                )}
              </section>
            )}
          </>
        )}
      </Frame>
      {toast && <Toast />}
    </NotePlaybackProvider>
  );
}
