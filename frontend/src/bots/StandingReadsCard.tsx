import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { ReadSummaryCard } from "./ReadSummaryCard";
import type { ReadSettings } from "./trustbotReadGrant";
import { standingReadsView, stopStandingReads, type StandingReadsView } from "./trustbotStandingReads";

const labels = { meetings: "meetings", feed_chats: "feed and chats" };
const openKeySettings = new URL("/dashboard/settings#renewing-permissions", import.meta.env.VITE_OPENKEY_HOST || "https://openkey.so").href;
const dateOf = (at: number) => new Date(at).toLocaleDateString(undefined, { dateStyle: "medium" });

export default function StandingReadsCard({ settings, revoke }: {
  settings: ReadSettings; revoke: (originalCid: string) => Promise<void>;
}) {
  const id = useId();
  const [saved, setSaved] = useState<StandingReadsView | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const attemptedRevoke = useRef<string | undefined>(undefined);
  const previous = saved?.previousOriginalCid;

  useEffect(() => {
    let current = true;
    const refresh = () => {
      void standingReadsView().then(value => { if (current) setSaved(value); }, () => {});
    };
    refresh();
    window.addEventListener("focus", refresh);
    return () => { current = false; window.removeEventListener("focus", refresh); };
  }, [settings]);
  const pending = saved?.pending;
  useEffect(() => {
    if (!pending || busy) return;
    let current = true;
    const timer = setInterval(() => {
      void standingReadsView().then(value => { if (current) setSaved(value); }, () => {});
    }, 3_000);
    return () => { current = false; clearInterval(timer); };
  }, [pending?.approveUrl, busy]);

  useEffect(() => {
    if (!previous || attemptedRevoke.current === previous) return;
    attemptedRevoke.current = previous;
    let current = true;
    setBusy(true);
    void stopStandingReads(previous, revoke).then(() => standingReadsView()).then(
      value => { if (current) setSaved(value); },
      () => { if (current) setFailed(true); },
    ).finally(() => { if (current) setBusy(false); });
    return () => { current = false; };
  }, [previous, revoke]);

  if (!saved || (!saved.areas.length && !saved.active && !pending && !saved.previousOriginalCid)) return null;

  const active = saved.active;
  const covered = (active?.areas ?? saved.areas).map(area => labels[area]).join(" and ");
  const scopeChanged = active && (saved.areas.length !== active.areas.length || saved.areas.some(area => !active.areas.includes(area)));
  const update = async (work: () => Promise<StandingReadsView | null>) => {
    setBusy(true);
    setFailed(false);
    try { setSaved(await work()); }
    catch { setFailed(true); }
    finally { setBusy(false); }
  };

  return (
    <>
      <section aria-labelledby={id} className="flex flex-col gap-2">
        <h2 id={id} className="text-headline">Keep bot reads on while you’re away</h2>
        <p className="text-callout text-muted-foreground">
          {active
            ? `Your bot can read your ${covered} through ${dateOf(active.validUntil)}. Access renews while your approval is active.`
            : `Let your bot keep reading your ${covered} for up to seven days, even with TinyChat closed.`}
        </p>
        {pending ? (
          <>
            <p className="text-callout text-muted-foreground">OpenKey shows what your bot can read. If you use an external wallet, it asks you to sign twice.</p>
            <a className="text-callout underline" href={pending.approveUrl} target="_blank" rel="noopener noreferrer">Review in OpenKey</a>
          </>
        ) : null}
        {active ? <a className="text-callout underline" href={openKeySettings} target="_blank" rel="noopener noreferrer">Manage renewal in OpenKey Settings</a> : null}
        <div className="flex flex-wrap gap-2">
          {!pending && (!active || scopeChanged) && saved.areas.length > 0
            ? <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void update(() => standingReadsView("POST"))}>Set up renewal</Button>
            : null}
          {failed && previous ? (
            <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void update(async () => {
              await stopStandingReads(previous, revoke);
              return standingReadsView();
            })}>Retry removing old permission</Button>
          ) : null}
          {active ? (
            <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void update(async () => {
              if (saved.previousOriginalCid) await stopStandingReads(saved.previousOriginalCid, revoke);
              await stopStandingReads(active.originalCid, revoke);
              return standingReadsView();
            })}>Turn off standing access</Button>
          ) : null}
        </div>
        {failed || saved.outcome === "failed" ? <p role="alert" className="text-callout">Couldn’t update bot reads. Try again.</p> : null}
        {saved.outcome === "declined" ? <p role="status" className="text-callout">Renewal wasn’t approved.</p> : null}
        {saved.outcome === "expired" ? <p role="status" className="text-callout">The approval ended.</p> : null}
      </section>
      {active ? <ReadSummaryCard key={active.originalCid} /> : null}
    </>
  );
}
