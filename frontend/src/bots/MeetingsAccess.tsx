// Main's Meetings setting (off by default), shown in Main's chat sheet next to Web access. Turning it on signs one
// read delegation covering every area that will then be on; the service keeps it for 7 days at most.
import { useEffect, useId, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { BotsRouteMissing } from "./botsApi";
import { MEETINGS_ACCESS_STRINGS as COPY } from "./botsStrings";
import type { ReadArea } from "./trustbotReadAreas";
import type { ReadGrant, ReadSettings } from "./trustbotReadGrant";

export interface MeetingsAccessApi {
  readSettings(): Promise<ReadSettings>;
  setReadArea(area: ReadArea, enabled: boolean, grant?: ReadGrant): Promise<ReadSettings>;
  signReadGrant(serviceDid: string, areas: ReadArea[]): Promise<ReadGrant>;
}

const AREA: ReadArea = "meetings";
const dateOf = (at: number) => new Date(at).toLocaleDateString(undefined, { dateStyle: "medium" });

function Confirm({ onConfirm, onCancel, busy }: { onConfirm: () => void; onCancel: () => void; busy: boolean }) {
  const id = useId();
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => { box.current?.focus(); }, []);
  return (
    <div
      ref={box}
      tabIndex={-1}
      role="alertdialog"
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-body`}
      className="flex flex-col gap-3 rounded-xl border border-border bg-muted p-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <p id={`${id}-title`} className="text-headline">{COPY.confirmTitle}</p>
      <p id={`${id}-body`} className="text-callout text-muted-foreground">{COPY.confirmBody}</p>
      <div className="flex flex-wrap gap-2">
        <Button type="button" disabled={busy} onClick={onConfirm}>{COPY.confirm}</Button>
        <Button type="button" variant="outline" disabled={busy} onClick={onCancel}>{COPY.cancel}</Button>
      </div>
    </div>
  );
}

/** Renders nothing while loading and when the service answers 404 (the feature is not on for this account). */
export function MeetingsAccess({ api }: { api: MeetingsAccessApi }) {
  const id = useId();
  const [saved, setSaved] = useState<ReadSettings | null>(null);
  const [missing, setMissing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  useEffect(() => {
    let current = true;
    api.readSettings().then(
      (settings) => { if (current) setSaved(settings); },
      (error: unknown) => {
        if (!current) return;
        if (error instanceof BotsRouteMissing) setMissing(true);
        else setFailed(true);
      },
    );
    return () => { current = false; };
  }, [api]);

  if (missing) return null;
  if (!saved) {
    return failed ? (
      <section aria-labelledby={`${id}-title`} className="flex flex-col gap-1" data-bots-meetings-access="">
        <h2 id={`${id}-title`} className="text-headline">{COPY.title}</h2>
        <p role="alert" className="text-callout text-muted-foreground">{COPY.failed}</p>
      </section>
    ) : null;
  }

  const state = saved.areas[AREA];

  const change = async (enabled: boolean) => {
    setFailed(false);
    setSaving(true);
    try {
      let stored: ReadSettings;
      if (enabled) {
        const areas = (Object.keys(saved.areas) as ReadArea[]).filter((area) => area === AREA || saved.areas[area] === "on");
        const grant = await api.signReadGrant(saved.serviceDid, areas);
        stored = await api.setReadArea(AREA, true, grant);
      } else {
        stored = await api.setReadArea(AREA, false);
      }
      if (!alive.current) return;
      setSaved(stored);
      setConfirming(false);
    } catch {
      if (!alive.current) return;
      setConfirming(false);
      setFailed(true);
    } finally {
      if (alive.current) setSaving(false);
    }
  };

  const line = state === "on"
    ? (saved.expiresAt === null ? "" : COPY.on(dateOf(saved.expiresAt)))
    : state === "ended" ? COPY.ended : COPY.off;

  return (
    <section aria-labelledby={`${id}-title`} className="flex flex-col gap-3" data-bots-meetings-access="">
      <div className="flex flex-col gap-1">
        <h2 id={`${id}-title`} className="text-headline">{COPY.title}</h2>
        {line ? <p className="text-callout text-muted-foreground">{line}</p> : null}
      </div>
      {confirming ? (
        <Confirm busy={saving} onConfirm={() => void change(true)} onCancel={() => setConfirming(false)} />
      ) : (
        <div>
          {state === "on" ? (
            <Button type="button" variant="outline" size="sm" disabled={saving} onClick={() => void change(false)}>{COPY.turnOff}</Button>
          ) : (
            <Button type="button" variant="outline" size="sm" disabled={saving} onClick={() => { setFailed(false); setConfirming(true); }}>{COPY.allow}</Button>
          )}
        </div>
      )}
      {failed ? <p role="alert" className="text-callout text-muted-foreground">{COPY.failed}</p> : null}
    </section>
  );
}
