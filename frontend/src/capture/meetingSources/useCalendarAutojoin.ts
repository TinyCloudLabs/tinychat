// Calendar autojoin for the Meeting sources window: the same status client,
// request-ownership actions and 60s poll `CalendarAutojoinSection` runs, as a
// hook. Turning it on goes through the Google connect flow (consent), so only
// "off" lives here.
import type { SessionStore } from "@tinyboilerplate/client";
import { useEffect, useMemo, useRef, useState } from "react";

import { createCalendarAutojoinActions } from "@/chat/CalendarAutojoinSection";
import {
  calendarOutcomeLabel,
  createCalendarAutojoinClient,
  type CalendarAutojoinStatus,
} from "@/lib/connectors/calendarAutojoinApi";

export interface CalendarAutojoinController {
  status: CalendarAutojoinStatus | null;
  error: string | null;
  busy: boolean;
  disable: () => void;
}

export function useCalendarAutojoin(input: {
  backendUrl: string;
  sessionStore: SessionStore;
  /** Bumped when a connect dialog closes, so the status is re-read. */
  revision: number;
  enabled: boolean;
}): CalendarAutojoinController {
  const { backendUrl, sessionStore, revision, enabled } = input;
  const api = useMemo(
    () => createCalendarAutojoinClient(backendUrl, sessionStore),
    [backendUrl, sessionStore],
  );
  const [status, setStatus] = useState<CalendarAutojoinStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const actions = useRef<ReturnType<typeof createCalendarAutojoinActions> | null>(null);
  useEffect(() => {
    if (!enabled) return;
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
  }, [api, revision, enabled]);
  return { status, error, busy, disable: () => void actions.current?.disable() };
}

/** The one line under the switch. Mirrors the flag-off section's states. */
export function autojoinDetail(
  status: CalendarAutojoinStatus | null,
  error: string | null,
): { scan: string; warning: string | null } {
  const scan = status?.lastScanAt
    ? new Date(status.lastScanAt).toLocaleString()
    : status
      ? "none yet"
      : "checking…";
  const warning =
    error ??
    (status?.state === "needs_reconnect"
      ? "Reconnect Google with renewed consent to resume unattended joining."
      : status?.state === "error"
        ? status.errorCode
          ? calendarOutcomeLabel(status.errorCode)
          : "Calendar scanning is paused. It will retry automatically."
        : null);
  return { scan, warning };
}
