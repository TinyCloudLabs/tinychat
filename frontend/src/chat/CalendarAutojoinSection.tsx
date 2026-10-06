import { useEffect, useMemo, useRef, useState } from "react";
import type { SessionStore } from "@tinyboilerplate/client";
import { Button } from "@/components/ui/button";
import { HowItWorksLink } from "@/components/ui/how-it-works-link";
import { InfoTip } from "@/components/ui/info-tip";
import { StatusDot, type StatusTone } from "@/components/ui/status-dot";
import { calendarOutcomeLabel, createCalendarAutojoinClient, type CalendarAutojoinStatus } from "@/lib/connectors/calendarAutojoinApi";

type CalendarAutojoinUpdate = Partial<{
  status: CalendarAutojoinStatus; error: string | null; busy: boolean;
}>;

/** Request ownership prevents pre-disable reads and unmounted requests from changing the UI. */
export function createCalendarAutojoinActions(
  api: ReturnType<typeof createCalendarAutojoinClient>,
  onUpdate: (update: CalendarAutojoinUpdate) => void,
) {
  let revision = 0;
  let disposed = false;
  let mutating = false;
  let refreshing = false;
  const current = (request: number) => !disposed && request === revision;
  return {
    async refresh() {
      if (disposed || mutating || refreshing) return;
      // A slow read must settle before polling can supersede its result.
      refreshing = true;
      const request = ++revision;
      try {
        const status = await api.status();
        if (current(request)) onUpdate({ status, error: null });
      } catch {
        if (current(request)) onUpdate({ error: "Calendar autojoin status is unavailable. Try again shortly." });
      } finally {
        refreshing = false;
      }
    },
    async disable() {
      if (disposed || mutating) return;
      const request = ++revision;
      mutating = true;
      onUpdate({ busy: true, error: null });
      try {
        const status = await api.disable();
        if (current(request)) onUpdate({ status });
      } catch {
        if (current(request)) onUpdate({ error: "Could not turn off autojoin. Try again." });
      } finally {
        mutating = false;
        if (current(request)) onUpdate({ busy: false });
      }
    },
    dispose() { disposed = true; ++revision; },
  };
}

export function CalendarAutojoinSection(props: {
  backendUrl: string; sessionStore: SessionStore; revision: number; onEnable: () => void;
}) {
  const api = useMemo(() => createCalendarAutojoinClient(props.backendUrl, props.sessionStore), [props.backendUrl, props.sessionStore]);
  const [status, setStatus] = useState<CalendarAutojoinStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const actions = useRef<ReturnType<typeof createCalendarAutojoinActions> | null>(null);
  useEffect(() => {
    const controller = createCalendarAutojoinActions(api, (update) => {
      if (update.status !== undefined) setStatus(update.status);
      if (update.error !== undefined) setError(update.error);
      if (update.busy !== undefined) setBusy(update.busy);
    });
    actions.current = controller;
    setBusy(false);
    void controller.refresh();
    const timer = window.setInterval(() => void controller.refresh(), 60_000);
    return () => {
      controller.dispose();
      if (actions.current === controller) actions.current = null;
      window.clearInterval(timer);
    };
  }, [api, props.revision]);
  const label = status?.state === "on" ? "On" : status?.state === "needs_reconnect" ? "Needs reconnect"
    : status?.state === "error" || error ? "Error" : status ? "Off" : "Loading…";
  const tone: StatusTone = label === "On" ? "primary" : label === "Needs reconnect" ? "warning" : label === "Error" ? "destructive" : "neutral";
  // A short label and a one-line hint; when it joins, what it can reach and
  // what turning it off removes are How it works → Connectors.
  return <div className="mt-3 border-t border-border pt-3 text-xs">
    <div className="flex items-center justify-between gap-2">
      <div className="flex flex-wrap items-center gap-x-2">
        <span className="flex items-center font-medium">
          Calendar autojoin
          <InfoTip label="About calendar autojoin" className="-my-3 fine:-my-1">
            A notetaker joins your confirmed Google Meet events, even while TinyChat is closed.
          </InfoTip>
        </span>
        <StatusDot tone={tone} className="text-muted-foreground" role="status">{label}</StatusDot>
      </div>
      <Button size="sm" variant="outline" role="switch" aria-label="Calendar autojoin" aria-checked={status?.enabled ?? false}
        disabled={busy || !status} onClick={() => status?.enabled ? void actions.current?.disable() : props.onEnable()}>
        {busy ? "Turning off…" : status?.enabled ? "Turn off" : status?.state === "needs_reconnect" ? "Reconnect" : "Turn on"}
      </Button>
    </div>
    <p className="mt-2 text-muted-foreground">Last successful scan: {status?.lastScanAt ? new Date(status.lastScanAt).toLocaleString() : "None yet"}</p>
    {status?.state === "needs_reconnect" && <p className="mt-1 text-muted-foreground">Reconnect Google with renewed consent to resume unattended joining.</p>}
    {status?.state === "error" && <p className="mt-1 text-destructive">{status.errorCode ? calendarOutcomeLabel(status.errorCode) : "Calendar scanning is paused. It will retry automatically."}</p>}
    {error && <p role="alert" className="mt-1 text-destructive">{error}</p>}
    <HowItWorksLink section="connectors" />
  </div>;
}
