// Meeting sources, rendered from the window's own presentational parts with the
// state written out, so the captures need no backend. `interactive` drives the
// same parts with local state for test/meeting-sources.e2e.test.ts.
import { PlugIcon } from "lucide-react";
import { useRef, useState } from "react";

import { initialBackgroundSyncState, type BackgroundSyncState } from "@/chat/backgroundSyncState";
import { ConfirmDialog } from "@/capture/meetingSources/ConfirmDialog";
import { DisconnectRow, FirefliesManage } from "@/capture/meetingSources/ManagePanel";
import {
  CalendarAutojoinRow,
  MeetingSourcesEntry,
  MeetingSourcesWindow,
  SourceRow,
} from "@/capture/meetingSources/MeetingSourcesView";
import { meetingSourceStatus } from "@/capture/meetingSources/meetingSourceState";
import { CONNECTORS } from "@/lib/connectors/registry";
import type { HarnessScreen } from "../screen";

const noop = () => {};

const enabledState: BackgroundSyncState = {
  ...initialBackgroundSyncState(),
  phase: "enabled",
  hasSecret: true,
  createdAt: "2026-10-01T09:00:00.000Z",
  revealClosed: true,
  queue: { pendingCount: 0, deadCount: 0, rateLimited: false, blockedReason: null },
};

const descriptor = (id: string) => {
  const found = CONNECTORS.find((d) => d.id === id);
  if (!found) throw new Error(`harness: no connector ${id}`);
  return found;
};

type Confirm = "rotate" | "disconnect" | null;

function MeetingSourcesFixture({
  connected: initiallyConnected = true,
  open: initiallyOpen = true,
  manage: initiallyManage = false,
  confirm: initialConfirm = null,
}: {
  connected?: boolean;
  open?: boolean;
  manage?: boolean;
  confirm?: Confirm;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  const [connected, setConnected] = useState(initiallyConnected);
  const [manage, setManage] = useState(initiallyManage);
  const [confirm, setConfirm] = useState<Confirm>(initialConfirm);
  const [instant, setInstant] = useState(true);
  const [autojoin, setAutojoin] = useState(false);
  const entryRef = useRef<HTMLButtonElement>(null);
  const fireflies = descriptor("fireflies");
  const google = descriptor("google-meet");
  const granola = descriptor("granola");
  const state: BackgroundSyncState = instant
    ? enabledState
    : { ...enabledState, phase: "off", hasSecret: false, createdAt: null };

  return (
    <div style={{ padding: 24, maxWidth: 560 }}>
      <MeetingSourcesEntry
        buttonRef={entryRef}
        connected={connected}
        summary={connected ? "Fireflies connected · 416 meetings" : "Nothing connected yet"}
        onClick={() => setOpen(true)}
      />
      <MeetingSourcesWindow open={open} onOpenChange={setOpen} returnFocus={() => entryRef.current}>
        <SourceRow
          id="fireflies"
          name={fireflies.name}
          description="Meeting transcripts from Fireflies.ai."
          Icon={fireflies.icon ?? PlugIcon}
          status={meetingSourceStatus(
            connected ? "connected" : "disconnected",
            "42 minutes ago",
            416,
          )}
          connected={connected}
          busy={false}
          syncing={false}
          manageOpen={manage}
          onConnect={() => setConnected(true)}
          onSync={noop}
          onToggleManage={() => setManage((was) => !was)}
          manage={
            <FirefliesManage
              connectorName={fireflies.name}
              state={state}
              consentVariant="C"
              ingestConsentChecked={false}
              consentOpen={false}
              onIngestConsentChange={noop}
              onToggleInstant={() => setInstant((was) => !was)}
              onConfirmEnable={noop}
              onCancelEnable={noop}
              onRotate={() => setConfirm("rotate")}
              onDismissReveal={noop}
              onCopy={noop}
              onSync={noop}
              onRetry={noop}
              onBringBack={noop}
              onDisconnect={() => setConfirm("disconnect")}
            />
          }
        />
        <SourceRow
          id="google-meet"
          name={google.name}
          description="Google Meet transcripts and Notes by Gemini."
          Icon={google.icon ?? PlugIcon}
          status={meetingSourceStatus("disconnected")}
          connected={false}
          busy={false}
          syncing={false}
          manageOpen={false}
          onConnect={noop}
          onSync={noop}
          onToggleManage={noop}
          manage={<DisconnectRow name={google.name} onDisconnect={noop} />}
          extra={<CalendarAutojoinRow on={autojoin} disabled={false} scan="none yet" warning={null} onToggle={() => setAutojoin((was) => !was)} />}
        />
        <SourceRow
          id="granola"
          name={granola.name}
          description="Notes and transcripts from Granola."
          Icon={granola.icon ?? PlugIcon}
          comingSoon
          status={null}
          connected={false}
          busy={false}
          syncing={false}
          manageOpen={false}
          onConnect={noop}
          onSync={noop}
          onToggleManage={noop}
        />
      </MeetingSourcesWindow>
      <ConfirmDialog
        open={confirm === "rotate"}
        title="Rotate the webhook secret?"
        message="Exo issues a new address and secret. The old ones stop working right away, so paste the new ones into your Fireflies webhook."
        keepLabel="Keep the current one"
        dropLabel="Rotate"
        onKeep={() => setConfirm(null)}
        onDrop={() => setConfirm(null)}
        testId="confirm-rotate"
      />
      <ConfirmDialog
        open={confirm === "disconnect"}
        title={`Disconnect ${fireflies.name}?`}
        message="Meetings already in your space stay. New ones stop arriving."
        keepLabel="Keep connected"
        dropLabel="Disconnect"
        onKeep={() => setConfirm(null)}
        onDrop={() => {
          setConfirm(null);
          setManage(false);
          setConnected(false);
        }}
        returnFocus={() => document.querySelector<HTMLElement>('[data-source="fireflies"] .ms-btn1')}
        testId="confirm-disconnect"
      />
    </div>
  );
}

const WINDOW = '[data-testid="meeting-sources-window"]';

function screen(
  name: string,
  readyWhen: string,
  props: Parameters<typeof MeetingSourcesFixture>[0],
  interactive = false,
): HarnessScreen {
  return {
    id: `meeting-sources-${name}`,
    group: "meetingSources",
    layout: "pane",
    path: "/chat/connectors",
    platform: "web",
    readyWhen,
    interactive,
    render: () => <MeetingSourcesFixture {...props} />,
  };
}

export const meetingSourcesScreens: HarnessScreen[] = [
  screen("connected", WINDOW, {}),
  screen("not-connected", WINDOW, { connected: false }),
  screen("manage", `${WINDOW} [aria-expanded="true"]`, { manage: true }),
  screen("rotate", '[data-testid="confirm-rotate"]', { manage: true, confirm: "rotate" }),
  screen("disconnect", '[data-testid="confirm-disconnect"]', { manage: true, confirm: "disconnect" }),
  screen("interactive", ".ms-entry", { open: false }, true),
];
