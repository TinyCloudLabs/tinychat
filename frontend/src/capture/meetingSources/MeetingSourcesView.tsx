// Presentational pieces of the Meeting sources window, so the container and the
// harness fixtures render the same markup. Nothing here fetches or decides:
// state comes in through props, intent goes out through callbacks.
import * as Dialog from "@radix-ui/react-dialog";
import { ChevronDownIcon, ChevronRightIcon, CircleAlertIcon, PlugIcon, XIcon } from "lucide-react";
import { useRef, type ComponentType, type ReactNode } from "react";
import { Link } from "react-router-dom";

import { aboutHref } from "@/lib/about";
import { useSoftTheme } from "../home/softTheme";
import type { MeetingSourceStatus } from "./meetingSourceState";
import "../recorder/final/soft.css";
import "./meetingSources.css";

export function MeetingSourcesWindow({
  open,
  onOpenChange,
  returnFocus,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The entry that opened the window; Radix would look for a Trigger that does not exist. */
  returnFocus: () => HTMLElement | null;
  children: ReactNode;
}) {
  const theme = useSoftTheme();
  const closeRef = useRef<HTMLButtonElement>(null);
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className={`ms-veil ${theme}`} />
        <Dialog.Content
          className={`soft-skin ${theme} ms-window`}
          data-layout="desktop"
          data-testid="meeting-sources-window"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            closeRef.current?.focus({ preventScroll: true });
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            const target = returnFocus();
            if (target?.isConnected) target.focus({ preventScroll: true });
          }}
        >
          <header className="ms-head">
            <span className="ms-tile ms-tile-lg" aria-hidden="true">
              <PlugIcon />
            </span>
            <div className="ms-head-copy">
              <Dialog.Title className="soft-title ms-title">Meeting sources</Dialog.Title>
              <Dialog.Description className="ms-sub">
                Bring meeting notes into your private space. <HowItWorks />
              </Dialog.Description>
            </div>
            <Dialog.Close ref={closeRef} className="ms-close" aria-label="Close">
              <XIcon aria-hidden="true" />
            </Dialog.Close>
          </header>
          <div className="ms-body">{children}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** Failures stay monochrome: the icon and the weight carry them, red is only for recording. */
export function InlineError({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="ms-row-error">
      <CircleAlertIcon aria-hidden="true" />
      <span>{children}</span>
    </p>
  );
}

function HowItWorks() {
  return (
    <Link to={aboutHref("connectors")} className="ms-link">
      How it works
      <ChevronRightIcon aria-hidden="true" />
    </Link>
  );
}

/** The Capture / Connectors entry card. */
export function MeetingSourcesEntry({
  summary,
  connected,
  onClick,
  buttonRef,
}: {
  summary: string;
  connected: boolean;
  onClick: () => void;
  buttonRef?: React.Ref<HTMLButtonElement>;
}) {
  const theme = useSoftTheme();
  return (
    <div className={`soft-skin ${theme} ms-entry-host`} data-layout="desktop">
      <button ref={buttonRef} type="button" className="ms-entry" onClick={onClick}>
        <span className="ms-tile ms-tile-lg" aria-hidden="true">
          <PlugIcon />
        </span>
        <span className="ms-entry-copy">
          <b>Meeting sources</b>
          <span className="ms-entry-sub">Fireflies, Google Meet and Granola</span>
          <span className="ms-status" data-tone={connected ? "on" : "off"}>
            <i aria-hidden="true" />
            <span>{summary}</span>
          </span>
        </span>
        <ChevronRightIcon className="ms-entry-chev" aria-hidden="true" />
      </button>
    </div>
  );
}

export interface SourceRowProps {
  id: string;
  name: string;
  description: string;
  Icon: ComponentType<{ className?: string }>;
  comingSoon?: boolean;
  status: MeetingSourceStatus | null;
  /**
   * Whether the connection has been read. Connect is offered only after a confirmed
   * "not connected"; while loading there is no action, and a failed read says so.
   */
  lookup: "loading" | "failed" | "ready";
  connected: boolean;
  /** Connecting or syncing: the primary action is inert and says what is happening. */
  busy: boolean;
  syncing: boolean;
  manageOpen: boolean;
  error?: string | null;
  onConnect: () => void;
  onRetryLookup: () => void;
  onSync: () => void;
  onToggleManage: () => void;
  /** Manage panel contents (only rendered when connected and open). */
  manage?: ReactNode;
  /** Always-visible extra block under the row (Calendar autojoin). */
  extra?: ReactNode;
}

export function SourceRow(props: SourceRowProps) {
  const { id, Icon } = props;
  return (
    <section className="ms-row" aria-labelledby={`ms-${id}`} data-source={id}>
      <span className="ms-tile" aria-hidden="true">
        <Icon />
      </span>
      <div className="ms-row-copy">
        <h4 className="ms-name" id={`ms-${id}`}>
          {props.name}
        </h4>
        <p className="ms-desc">{props.description}</p>
        {props.lookup === "loading" && !props.comingSoon && (
          <p className="ms-status" data-tone="busy" data-testid="ms-lookup-loading">
            <i aria-hidden="true" />
            <span className="ms-sr">Checking {props.name}</span>
          </p>
        )}
        {props.lookup === "ready" && props.status && (
          <p className="ms-status" data-tone={props.status.tone}>
            <i aria-hidden="true" />
            <span>{props.status.text}</span>
          </p>
        )}
        {props.lookup === "failed" && !props.comingSoon && (
          <InlineError>Couldn&apos;t check {props.name}</InlineError>
        )}
        {props.error && <InlineError>{props.error}</InlineError>}
      </div>
      <div className="ms-actions">
        {props.comingSoon ? (
          <span className="ms-soon">Coming soon</span>
        ) : props.lookup === "loading" ? null : props.lookup === "failed" ? (
          <button type="button" className="ms-btn2" onClick={props.onRetryLookup}>
            Try again
          </button>
        ) : props.connected ? (
          <>
            <button
              type="button"
              className="ms-btn2"
              aria-disabled={props.busy}
              onClick={() => {
                if (!props.busy) props.onSync();
              }}
            >
              {props.syncing ? "Syncing…" : "Sync now"}
            </button>
            <button
              type="button"
              className="ms-btn2"
              aria-expanded={props.manageOpen}
              aria-controls={`msx-${id}`}
              onClick={props.onToggleManage}
            >
              Manage
              <ChevronDownIcon aria-hidden="true" />
            </button>
          </>
        ) : (
          <button
            type="button"
            className="ms-btn1"
            aria-disabled={props.busy}
            onClick={() => {
              if (!props.busy) props.onConnect();
            }}
          >
            {props.busy ? "Connecting…" : "Connect"}
          </button>
        )}
      </div>
      {props.connected && props.manageOpen && (
        <div className="ms-panel" id={`msx-${id}`}>
          {props.manage}
        </div>
      )}
      {props.extra}
    </section>
  );
}

// ── Option rows ──────────────────────────────────────────────────────

export function OptionRow({
  title,
  children,
  control,
}: {
  title: string;
  children?: ReactNode;
  control?: ReactNode;
}) {
  return (
    <div className="ms-opt">
      <div className="ms-opt-copy">
        <b>{title}</b>
        {children}
      </div>
      {control}
    </div>
  );
}

export function Switch({
  checked,
  label,
  disabled = false,
  onToggle,
}: {
  checked: boolean;
  label: string;
  disabled?: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      className="ms-switch"
      aria-checked={checked}
      aria-label={label}
      aria-disabled={disabled}
      onClick={() => {
        if (!disabled) onToggle();
      }}
    />
  );
}

export function LinkButton({
  children,
  danger = false,
  disabled = false,
  chevron = false,
  onClick,
}: {
  children: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  chevron?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="ms-link"
      data-danger={danger || undefined}
      aria-disabled={disabled}
      onClick={() => {
        if (!disabled) onClick();
      }}
    >
      {children}
      {chevron && <ChevronRightIcon aria-hidden="true" />}
    </button>
  );
}

/** Calendar autojoin, flat under Google Meet. On is a switch; turning it on goes through the Google connect flow. */
export function CalendarAutojoinRow({
  on,
  disabled,
  scan,
  warning,
  onToggle,
}: {
  on: boolean;
  disabled: boolean;
  scan: string;
  warning: string | null;
  onToggle: () => void;
}) {
  return (
    <div className="ms-extra">
      <div className="ms-opt">
        <div className="ms-opt-copy">
          <b>Calendar autojoin</b>
          <p className="ms-opt-text">
            Exo&apos;s notetaker joins the Google Meet calls on your calendar and transcribes them.
            Last scan: {scan}.
          </p>
          {warning && <InlineError>{warning}</InlineError>}
          <HowItWorks />
        </div>
        <Switch checked={on} label="Calendar autojoin" disabled={disabled} onToggle={onToggle} />
      </div>
    </div>
  );
}
