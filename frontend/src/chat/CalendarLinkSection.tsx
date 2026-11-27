// "Link Google Calendar": the optional, read-only consent that links recordings to calendar events.
// It is its own row, separate from Calendar autojoin and from the Google Meet connector: it works with
// Meet never connected and autojoin off, and neither of those changes it.
//
// The rules live in `createCalendarLinkActions` and `calendarLinkDisplay`, which the connector settings
// card (below) and the Meeting sources window both use, each with its own markup.

import { useEffect, useRef, useState } from "react";
import type { SessionStore } from "@tinyboilerplate/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { HowItWorksLink } from "@/components/ui/how-it-works-link";
import { StatusDot, type StatusTone } from "@/components/ui/status-dot";
import { calendarLinkRunner, type CalendarBackfillResult } from "@/lib/calendarLink/linkRunner";
import {
  CALENDAR_LINK_DESCRIPTION,
  CALENDAR_LINK_REMOVE_DETAILS_LABEL,
  CALENDAR_LINK_UNAVAILABLE_COPY,
  GOOGLE_CALENDAR_LINK_CONSENT_COPY,
} from "@/lib/connectors/consentCopy";
import {
  disconnectCalendarLink,
  onCalendarLinkStatus,
  readCalendarLinkStatus,
  type CalendarLinkStatus,
} from "@/lib/connectors/googleCalendarLink";

const CALENDAR_UNREADABLE = "Your calendar can't be read right now. Try again shortly.";
const UNLINKED = "TinyCloud One stopped reading your calendar and deleted its access token.";

/** What unlinking did to Google access itself, as `disconnectCalendarLink` reports it. */
export type CalendarUnlinkUpstream = "revoked" | "kept" | "failed" | "no-token";

/**
 * The one line shown after Unlink. Every variant says only what unlinking always does; Google access
 * itself is reported as removed only when the server's grant guard actually removed it.
 */
export function calendarUnlinkMessage(upstream: CalendarUnlinkUpstream): string {
  switch (upstream) {
    case "revoked":
      return `${UNLINKED} Google access was removed.`;
    case "kept":
      return `${UNLINKED} Google access stays in place because another TinyCloud One Google feature may use it. Remove it any time in your Google Account under Third-party connections.`;
    case "failed":
      return `${UNLINKED} Google could not be asked to remove access. Remove it in your Google Account under Third-party connections.`;
    case "no-token":
      return "TinyCloud One stopped reading your calendar and has no access token left.";
  }
}

export function calendarBackfillMessage(result: CalendarBackfillResult | null): string {
  return result === null ? CALENDAR_UNREADABLE : `Linked ${result.linked}. ${result.ambiguous} need your pick.`;
}

/** Whether this server mounts `/api/connectors/google/oauth/*`. `unknown`: it could not be asked. */
export type GoogleOAuthRoutes = "available" | "unavailable" | "unknown";

const routeProbes = new Map<string, Promise<GoogleOAuthRoutes>>();

/**
 * Asked once per backend per session, because nothing else in the app knows before a sign-in fails.
 * An authenticated `POST /refresh` with an empty body costs nothing upstream: the mounted route
 * refuses it (400 `invalid_request`), an unmounted one is a 404. Only a definite answer is cached.
 */
export function probeGoogleOAuthRoutes(input: {
  backendUrl: string;
  sessionStore: SessionStore;
  fetchImpl?: typeof fetch;
}): Promise<GoogleOAuthRoutes> {
  const cached = routeProbes.get(input.backendUrl);
  if (cached) return cached;
  const probe = (async (): Promise<GoogleOAuthRoutes> => {
    const bearer = input.sessionStore.getToken();
    if (!bearer || input.sessionStore.isExpired()) return "unknown";
    try {
      const response = await (input.fetchImpl ?? fetch)(`${input.backendUrl}/api/connectors/google/oauth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${bearer}`, "X-Requested-With": "XMLHttpRequest" },
        body: "{}",
      });
      if (response.status === 404) return "unavailable";
      // A rejected session or a failing server says nothing about the route.
      return response.status === 401 || response.status >= 500 ? "unknown" : "available";
    } catch {
      return "unknown";
    }
  })();
  routeProbes.set(input.backendUrl, probe);
  void probe.then((answer) => {
    if (answer === "unknown" && routeProbes.get(input.backendUrl) === probe) routeProbes.delete(input.backendUrl);
  });
  return probe;
}

export interface CalendarLinkView {
  /** Null until the first read. */
  status: CalendarLinkStatus | null;
  /** Null until asked; only asked while linking is not connected. */
  routes: GoogleOAuthRoutes | null;
  busy: "link" | "unlink" | "backfill" | null;
  /** What the last Unlink or "Link existing notes" did. */
  notice: string | null;
  error: string | null;
}

const INITIAL_VIEW: CalendarLinkView = { status: null, routes: null, busy: null, notice: null, error: null };

export interface CalendarLinkDeps {
  readStatus: () => Promise<CalendarLinkStatus>;
  routes: () => Promise<GoogleOAuthRoutes>;
  disconnect: (removeDetails: boolean) => Promise<{ upstream: CalendarUnlinkUpstream }>;
  backfill: () => Promise<CalendarBackfillResult | null>;
}

export interface CalendarLinkActions {
  /** Skipped during an action: the action reads the status itself when it ends. */
  refresh(): Promise<void>;
  link(): Promise<void>;
  unlink(removeDetails: boolean): Promise<void>;
  linkExisting(): Promise<void>;
  dispose(): void;
}

/**
 * The row's actions. `onOpen` opens the consent dialog, and is reached only after this server is known
 * to mount the Google OAuth routes: a sign-in window is never opened onto a 404, and a server that
 * cannot be asked is an error the row shows, never a press that does nothing.
 */
export function createCalendarLinkActions(
  deps: CalendarLinkDeps,
  onUpdate: (update: Partial<CalendarLinkView>) => void,
  onOpen: () => void,
): CalendarLinkActions {
  let disposed = false;
  let mutating = false;
  let reads = 0;
  const update = (patch: Partial<CalendarLinkView>) => { if (!disposed) onUpdate(patch); };
  const readStatus = async () => {
    const request = ++reads;
    try {
      const status = await deps.readStatus();
      if (request !== reads) return;
      update({ status });
      if (status.state === "connected") return;
      const routes = await deps.routes();
      if (request === reads) update({ routes });
    } catch {
      if (request === reads) update({ error: "Calendar link status is unavailable. Try again shortly." });
    }
  };
  const run = async (busy: NonNullable<CalendarLinkView["busy"]>, failure: string, work: () => Promise<Partial<CalendarLinkView>>) => {
    if (disposed || mutating) return;
    mutating = true;
    update({ busy, notice: null, error: null });
    try {
      update(await work());
    } catch {
      update({ error: failure });
    } finally {
      mutating = false;
      update({ busy: null });
    }
  };
  return {
    async refresh() {
      if (!disposed && !mutating) await readStatus();
    },
    link: () => run("link", "Couldn't reach the server to link your calendar. Try again.", async () => {
      const routes = await deps.routes();
      if (routes === "unknown") throw new Error("routes unknown");
      if (routes === "available" && !disposed) onOpen();
      return { routes };
    }),
    unlink: (removeDetails: boolean) => run("unlink", "Could not unlink Google Calendar. Try again.", async () => {
      try {
        const { upstream } = await deps.disconnect(removeDetails);
        return { notice: calendarUnlinkMessage(upstream) };
      } finally {
        await readStatus();
      }
    }),
    linkExisting: () => run("backfill", CALENDAR_UNREADABLE, async () => (
      { notice: calendarBackfillMessage(await deps.backfill()) }
    )),
    dispose() { disposed = true; },
  };
}

/** What either surface shows for a view: one status word, the actions on offer, and the lines under them. */
export interface CalendarLinkDisplay {
  label: "Loading…" | "Off" | "Linked" | "Needs reconnect";
  /** The consent action on offer. Null while loading, when linked, and on a server that cannot start it. */
  connect: "Link" | "Reconnect" | null;
  canUnlink: boolean;
  canLinkExisting: boolean;
  /** This server has no Google OAuth routes: said in words in place of the Link button. */
  unavailable: boolean;
  busy: CalendarLinkView["busy"];
  notice: string | null;
  error: string | null;
}

export function calendarLinkDisplay(view: CalendarLinkView): CalendarLinkDisplay {
  const state = view.status?.state ?? null;
  const unavailable = state !== null && state !== "connected" && view.routes === "unavailable";
  return {
    label: state === null ? "Loading…" : state === "connected" ? "Linked" : state === "needs-reconnect" ? "Needs reconnect" : "Off",
    connect: state === null || state === "connected" || unavailable ? null : state === "needs-reconnect" ? "Reconnect" : "Link",
    canUnlink: state === "connected" || state === "needs-reconnect",
    canLinkExisting: state === "connected",
    unavailable,
    busy: view.busy,
    notice: view.notice,
    error: view.error,
  };
}

/** The row's state and actions for one signed-in space. `onLink` opens the consent dialog with purpose `calendar-link`. */
export function useCalendarLinkSettings(input: {
  tcw: TinyCloudWeb;
  backendUrl: string;
  sessionStore: SessionStore;
  /** False while the surface is closed: nothing is read. */
  enabled?: boolean;
  onLink: () => void;
}) {
  const { tcw, backendUrl, sessionStore, enabled = true } = input;
  const [view, setView] = useState<CalendarLinkView>(INITIAL_VIEW);
  const actions = useRef<CalendarLinkActions | null>(null);
  const onLink = useRef(input.onLink);
  useEffect(() => { onLink.current = input.onLink; }, [input.onLink]);
  useEffect(() => {
    if (!enabled) return;
    const controller = createCalendarLinkActions({
      readStatus: () => readCalendarLinkStatus(tcw),
      routes: () => probeGoogleOAuthRoutes({ backendUrl, sessionStore }),
      disconnect: (removeDetails) => disconnectCalendarLink({ tcw, backendUrl, sessionStore, removeDetails }),
      backfill: async () => (await calendarLinkRunner({ tcw, backendUrl, sessionStore })?.backfill()) ?? null,
    }, (update) => setView((old) => ({ ...old, ...update })), () => onLink.current());
    actions.current = controller;
    setView(INITIAL_VIEW);
    void controller.refresh();
    const stop = onCalendarLinkStatus((changed) => { if (changed === tcw) void controller.refresh(); });
    return () => {
      stop();
      controller.dispose();
      if (actions.current === controller) actions.current = null;
    };
  }, [tcw, backendUrl, sessionStore, enabled]);
  return {
    display: calendarLinkDisplay(view),
    link: () => void actions.current?.link(),
    unlink: (removeDetails: boolean) => void actions.current?.unlink(removeDetails),
    linkExisting: () => void actions.current?.linkExisting(),
  };
}

const TONE: Readonly<Record<CalendarLinkDisplay["label"], StatusTone>> = {
  "Loading…": "neutral",
  Off: "neutral",
  Linked: "primary",
  "Needs reconnect": "warning",
};

/** The row as the connector settings card draws it. Nothing here fetches or decides. */
export function CalendarLinkControls(props: {
  display: CalendarLinkDisplay;
  onLink: () => void;
  onUnlink: () => void;
  onLinkExisting: () => void;
}) {
  const { display } = props;
  const busy = display.busy !== null;
  return <div data-testid="calendar-link-section" className="text-xs">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2">
        <span className="font-medium">{GOOGLE_CALENDAR_LINK_CONSENT_COPY.heading}</span>
        <StatusDot tone={TONE[display.label]} className="text-muted-foreground" role="status">{display.label}</StatusDot>
      </div>
      <div className="flex flex-wrap items-center justify-end gap-2">
        {display.canLinkExisting && (
          <Button size="sm" variant="outline" disabled={busy} onClick={props.onLinkExisting}>
            {display.busy === "backfill" ? "Linking notes…" : "Link existing notes"}
          </Button>
        )}
        {display.connect && (
          <Button size="sm" variant={display.connect === "Link" ? "default" : "outline"} disabled={busy} onClick={props.onLink}>
            {display.connect}
          </Button>
        )}
        {display.canUnlink && (
          <Button size="sm" variant="outline" disabled={busy} onClick={props.onUnlink}>
            {display.busy === "unlink" ? "Unlinking…" : "Unlink"}
          </Button>
        )}
      </div>
    </div>
    <p className="mt-2 text-muted-foreground">{CALENDAR_LINK_DESCRIPTION}</p>
    {display.unavailable && <p className="mt-1 text-muted-foreground">{CALENDAR_LINK_UNAVAILABLE_COPY}</p>}
    {display.notice && <p role="status" className="mt-1 text-muted-foreground">{display.notice}</p>}
    {display.error && <p role="alert" className="mt-1 text-destructive">{display.error}</p>}
    <HowItWorksLink section="connectors" />
  </div>;
}

export function CalendarLinkSection(props: {
  tcw: TinyCloudWeb; backendUrl: string; sessionStore: SessionStore; onLink: () => void;
}) {
  const link = useCalendarLinkSettings(props);
  const [confirming, setConfirming] = useState(false);
  const [removeDetails, setRemoveDetails] = useState(false);
  return <>
    <CalendarLinkControls display={link.display} onLink={link.link} onLinkExisting={link.linkExisting}
      onUnlink={() => { setRemoveDetails(false); setConfirming(true); }} />
    <AlertDialog open={confirming} onOpenChange={setConfirming}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Unlink Google Calendar?</AlertDialogTitle>
          <AlertDialogDescription>{GOOGLE_CALENDAR_LINK_CONSENT_COPY.disconnectNote}</AlertDialogDescription>
        </AlertDialogHeader>
        <label className="flex cursor-pointer items-start gap-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-sm">
          <input type="checkbox" className="mt-0.5 size-4 shrink-0 cursor-pointer accent-primary"
            checked={removeDetails} onChange={(event) => setRemoveDetails(event.target.checked)} />
          <span>{CALENDAR_LINK_REMOVE_DETAILS_LABEL}</span>
        </label>
        <AlertDialogFooter>
          <AlertDialogCancel className="h-8 px-3 text-xs">Cancel</AlertDialogCancel>
          <Button variant="destructive" size="sm" onClick={() => { setConfirming(false); link.unlink(removeDetails); }}>
            Unlink
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </>;
}
