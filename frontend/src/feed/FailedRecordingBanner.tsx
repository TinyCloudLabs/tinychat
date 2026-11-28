import { useEffect, useMemo, useState } from "react";
import { TriangleAlertIcon } from "lucide-react";
import type { CalendarAutojoinOutcome, CalendarAutojoinStatus } from "@/lib/connectors/calendarAutojoinApi";
import {
  failedRecordingCard, failedRecordingDismissals, failedRecordingsToShow, FAILED_RECORDING_COPY, FAILED_RECORDING_POLL_MS,
  type FailedRecordingDismissals,
} from "@/lib/connectors/failedRecordingNotice";

/**
 * Home's notice for a calendar auto-join recording that ended failed (TC-4461). It reads the status the app already reads
 * for calendar autojoin, on open and every ten minutes while Home is open, and shows the failed recordings from the last
 * day that the owner has not dismissed on this device. One Dismiss hides every recording the card counts.
 *
 * A read that fails or is slow changes nothing: the card neither appears from a guess nor goes away as if all were well.
 * The status is replaced only when the list of outcomes differs, so an unchanged poll does not re-render the card and a
 * screen reader does not hear it again.
 */
export function FailedRecordingBanner({ calendar, subject, dismissals = failedRecordingDismissals, now = Date.now, pollMs = FAILED_RECORDING_POLL_MS }: {
  calendar: { status(): Promise<Pick<CalendarAutojoinStatus, "outcomes">> };
  /** The owner's did:pkh; null before sign-in. */
  subject: string | null | undefined;
  dismissals?: FailedRecordingDismissals;
  now?: () => number;
  pollMs?: number;
}) {
  const [outcomes, setOutcomes] = useState<CalendarAutojoinOutcome[]>([]);
  const [dismissedChanges, setDismissedChanges] = useState(0);
  const [clock, setClock] = useState(() => now());
  useEffect(() => dismissals.subscribe(() => setDismissedChanges((count) => count + 1)), [dismissals]);
  useEffect(() => {
    if (!subject) { setOutcomes([]); return; }
    let alive = true;
    let signature = "";
    const read = async () => {
      try {
        const status = await calendar.status();
        if (!alive) return;
        const next = Array.isArray(status.outcomes) ? status.outcomes : [];
        const nextSignature = JSON.stringify(next.map((outcome) => [outcome.id, outcome.reason, outcome.start, outcome.title ?? "", outcome.failureCode ?? ""]));
        if (nextSignature !== signature) { signature = nextSignature; setOutcomes(next); }
        setClock(now());
      } catch { /* Nothing changes on a failed read. */ }
    };
    void read();
    const timer = setInterval(() => { void read(); }, pollMs);
    return () => { alive = false; clearInterval(timer); };
  }, [calendar, subject, now, pollMs]);
  const card = useMemo(() => {
    if (!subject) return null;
    return failedRecordingCard(failedRecordingsToShow(outcomes, dismissals.read(subject), clock));
    // dismissedChanges re-reads the device's dismissals after a Dismiss.
  }, [outcomes, subject, dismissals, clock, dismissedChanges]);
  if (!card || !subject) return null;
  return (
    <div role="status" data-testid="failed-recording-banner" className="mb-4 flex items-start gap-3 rounded-2xl border-l-4 border-warning bg-card px-4 py-3 text-sm leading-[1.45] shadow-[inset_0_0_0_1px_hsl(var(--border))]">
      <TriangleAlertIcon aria-hidden className="mt-px size-5 shrink-0 text-warning" />
      <div className="min-w-0">
        <p className="font-semibold">{card.lead}</p>
        <p className="min-w-0">{card.prefix}{card.title}: {card.reason}</p>
        <button type="button" aria-label={card.dismissLabel} onClick={() => dismissals.write(subject, card.ids)} className="mt-2 min-h-11 underline">{FAILED_RECORDING_COPY.dismiss}</button>
      </div>
    </div>
  );
}
