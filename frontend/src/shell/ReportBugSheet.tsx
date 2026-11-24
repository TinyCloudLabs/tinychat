// TC-3716: the Report a bug sheet. Everything here lives in component state only: closing the sheet drops the
// note and the screenshot. Drag down, the scrim, Escape or Not now closes it, except while a send is in flight.
import { useEffect, useId, useMemo, useState, type ClipboardEvent } from "react";

import { Button } from "@/components/ui/button";
import { ResponsiveSheet, ResponsiveSheetBody } from "@/components/ui/responsive-sheet";
import type { RecentErrorLine, ReportContext, ReportTrigger } from "@/lib/reportBug/context";
import { reencodeImage, type JpegBytes } from "@/lib/reportBug/image";
import { redactForReport } from "@/lib/reportBug/redact";
import { NOTE_MAX_CHARS, sendReport, type ReportSigner, type SendOutcome } from "@/lib/reportBug/send";
import { REPORT_BUG_STRINGS as S } from "@/lib/reportBug/strings";

export interface ReportBugSheetProps {
  open: boolean;
  trigger: ReportTrigger;
  /** The app's own snapshot from the screenshot that opened the sheet; `sensitive` starts it detached. */
  screenshot: { bytes: JpegBytes; sensitive: boolean } | null;
  /** Null when signed out: the report goes unsigned and can't carry a screenshot. */
  signer: ReportSigner | null;
  /** Web and the Mac app: the person can pick or paste an image (no screenshot is captured there). */
  canAttachFile: boolean;
  context: ReportContext;
  recentErrors: RecentErrorLine[];
  origin: string;
  send?: typeof sendReport;
  onOpenChange: (open: boolean) => void;
  onSent: () => void;
}

type Status = "idle" | "sending" | "no_text" | SendOutcome["kind"];

export function ReportBugSheet(props: ReportBugSheetProps) {
  const { open, trigger, signer, canAttachFile, context, recentErrors, origin, onOpenChange, onSent } = props;
  const send = props.send ?? sendReport;
  const id = useId();
  const [note, setNote] = useState("");
  const [image, setImage] = useState<JpegBytes | null>(props.screenshot?.bytes ?? null);
  const [attached, setAttached] = useState(props.screenshot ? !props.screenshot.sensitive : false);
  // A sensitive screen's snapshot starts detached and says why, until the person attaches it once.
  const [sensitiveHold, setSensitiveHold] = useState(props.screenshot?.sensitive === true);
  const [status, setStatus] = useState<Status>("idle");
  const sending = status === "sending";
  const done = status === "sent" || status === "sent_without_screenshot";
  // Unverified reports can't carry a screenshot, so signed out there is no screenshot row at all.
  const screenshotRow = signer !== null && (image !== null || canAttachFile);
  const shown = signer !== null && attached ? image : null;

  const thumbnail = useMemo(() => (shown ? URL.createObjectURL(new Blob([shown], { type: "image/jpeg" })) : null), [shown]);
  useEffect(() => () => { if (thumbnail) URL.revokeObjectURL(thumbnail); }, [thumbnail]);

  const attachFile = async (file: Blob | null | undefined) => {
    if (!file || !file.type.startsWith("image/")) return;
    const bytes = await reencodeImage(file);
    if (!bytes) return;
    setImage(bytes);
    setAttached(true);
  };

  const submit = async () => {
    if (!note.trim()) return setStatus("no_text");
    setStatus("sending");
    const outcome = await send({ origin, happened: note, context, recentErrors, screenshot: shown, signer, fetch: globalThis.fetch.bind(globalThis), now: Date.now });
    setStatus(outcome.kind);
    if (outcome.kind === "sent" || outcome.kind === "sent_without_screenshot") onSent();
  };

  const message = status === "no_text" ? S.errorNoText : status === "failed" ? S.errorNetwork : status === "too_many" ? S.errorTooMany : null;

  return (
    <ResponsiveSheet
      open={open}
      onOpenChange={onOpenChange}
      dismissible={!sending}
      title={S.title}
      description={done ? undefined : trigger === "screenshot" ? S.subtitleScreenshot : S.subtitleMenu}
      contentProps={{ "data-report-bug-sheet": "" }}
      footer={done ? undefined : (
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" disabled={sending} onClick={() => onOpenChange(false)}>{S.notNow}</Button>
          <Button type="button" disabled={sending} onClick={() => void submit()}>
            {sending ? S.sending : status === "failed" ? S.tryAgain : S.send}
          </Button>
        </div>
      )}
    >
      <ResponsiveSheetBody className="space-y-4 px-4 pb-5 pt-2">
        {done ? (
          <div role="status" className="space-y-1 py-2">
            <p className="text-body">{S.success}</p>
            {status === "sent_without_screenshot" && <p className="text-callout text-muted-foreground">{S.errorScreenshotRefused}</p>}
          </div>
        ) : (
          <>
            <div className="space-y-1.5">
              <label htmlFor={`${id}-note`} className="text-sm font-medium">{S.fieldLabel}</label>
              <textarea
                id={`${id}-note`}
                rows={4}
                maxLength={NOTE_MAX_CHARS}
                value={note}
                placeholder={S.placeholder}
                disabled={sending}
                aria-invalid={status === "no_text"}
                onChange={(event) => { setNote(event.target.value); if (status === "no_text") setStatus("idle"); }}
                onPaste={canAttachFile && signer ? (event: ClipboardEvent) => {
                  const file = [...event.clipboardData.files].find((f) => f.type.startsWith("image/"));
                  if (file) { event.preventDefault(); void attachFile(file); }
                } : undefined}
                className="block w-full resize-none rounded-md border border-input bg-background px-3 py-2.5 text-base text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring aria-invalid:border-destructive"
              />
              <div role="status" className="text-sm text-destructive empty:hidden">{message}</div>
            </div>

            {screenshotRow && (
              <div className="space-y-2">
                {shown && thumbnail ? (
                  <>
                    <div className="flex items-center gap-3">
                      <img src={thumbnail} alt="" className="h-16 w-auto max-w-24 rounded-md border border-border object-cover" />
                      <span className="flex-1 text-sm">{S.screenshotAttached}</span>
                      <Button type="button" variant="ghost" size="sm" disabled={sending} onClick={() => setAttached(false)}>{S.remove}</Button>
                    </div>
                    <p className="text-xs text-muted-foreground">{S.screenshotWarning}</p>
                  </>
                ) : image ? (
                  <div className="flex items-center gap-3">
                    <span className="flex-1 text-sm text-muted-foreground">
                      {sensitiveHold ? S.sensitive : S.noScreenshot}
                    </span>
                    <Button type="button" variant="ghost" size="sm" disabled={sending} onClick={() => { setAttached(true); setSensitiveHold(false); }}>
                      {sensitiveHold ? S.addIt : S.addBack}
                    </Button>
                  </div>
                ) : (
                  <label className="inline-flex min-h-11 cursor-pointer items-center text-sm font-medium underline underline-offset-2 fine:min-h-0">
                    {S.attach}
                    <input type="file" accept="image/*" className="sr-only" disabled={sending}
                      onChange={(event) => { void attachFile(event.target.files?.[0]); event.target.value = ""; }} />
                  </label>
                )}
              </div>
            )}

            <div className="space-y-1 text-xs text-muted-foreground">
              <p>{S.whatWeSend}</p>
              <details>
                <summary className="cursor-pointer font-medium text-foreground">{S.whatWeSendLink}</summary>
                <pre className="mt-2 whitespace-pre-wrap break-words rounded-md bg-muted p-2 font-mono text-xs">
                  {whatWeSend(context, recentErrors, note, signer !== null)}
                </pre>
              </details>
              <p>{signer ? (shown ? S.accountSignedInScreenshot : S.accountSignedIn) : S.accountSignedOut}</p>
            </div>
          </>
        )}
      </ResponsiveSheetBody>
    </ResponsiveSheet>
  );
}

/** The exact facts the report carries, as read-only lines; the note as it will be sent (redacted, then cut). */
function whatWeSend(context: ReportContext, recentErrors: RecentErrorLine[], note: string, signed: boolean): string {
  const lines = [
    `App: ${context.app}`,
    `Device: ${context.platform}${context.os ? ` ${context.os}` : ""}`,
    `Screen: ${context.screen}`,
    `Time: ${context.client_time}`,
    `Online: ${context.online ? "yes" : "no"}`,
    context.trigger === "screenshot" ? S.previewTriggerScreenshot : S.previewTriggerMenu,
  ];
  if (signed) lines.push(S.previewProof);
  for (const line of recentErrors) lines.push(`Error ${line.age_s}s ago: ${redactForReport(line.msg)}`);
  if (note.trim()) lines.push("", redactForReport(note).slice(0, NOTE_MAX_CHARS));
  return lines.join("\n");
}
