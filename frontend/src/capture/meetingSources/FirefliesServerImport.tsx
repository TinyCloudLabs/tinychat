// The "Import meetings while TinyCloud One is closed" row: the consent, the on state and turning it off.
// It only renders the phase the hook reports and hands intent back; the words are in firefliesImportCopy.ts.
import type { SessionStore } from "@tinyboilerplate/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { useState } from "react";

import {
  FIREFLIES_IMPORT_CANCEL,
  FIREFLIES_IMPORT_HEADING,
  FIREFLIES_IMPORT_KEEP_ON,
  FIREFLIES_IMPORT_NOT_NOW,
  FIREFLIES_IMPORT_OFF_BODY,
  FIREFLIES_IMPORT_PAUSED_LINE,
  FIREFLIES_IMPORT_SIGN_IN_TO_TURN_ON_LINE,
  FIREFLIES_IMPORT_TRY_AGAIN,
  FIREFLIES_IMPORT_TURN_OFF,
  FIREFLIES_IMPORT_TURN_OFF_CONFIRM,
  FIREFLIES_IMPORT_TURN_ON,
  FIREFLIES_IMPORT_UNAVAILABLE_LINE,
  firefliesImportDate,
  firefliesImportEndingSoonLine,
  firefliesImportOnLine,
  firefliesImportSignInLine,
  firefliesImportUnconfirmedLine,
} from "@/lib/connectors/firefliesImportCopy";
import { useFirefliesServerImport, type UseFirefliesServerImport } from "./useFirefliesServerImport";

/** Class names for the host surface: the meeting sources window by default, the Connectors card passes its own. */
export interface FirefliesServerImportClasses {
  root: string;
  copy: string;
  heading: string;
  text: string;
  actions: string;
  primary: string;
  secondary: string;
}

export const MEETING_SOURCES_CLASSES: FirefliesServerImportClasses = {
  root: "ms-opt",
  copy: "ms-opt-copy",
  heading: "",
  text: "ms-opt-text",
  actions: "ms-subpanel-actions",
  primary: "ms-btn1",
  secondary: "ms-btn2",
};

export const CONNECTORS_CARD_CLASSES: FirefliesServerImportClasses = {
  root: "flex flex-col gap-1",
  copy: "flex flex-col gap-2",
  heading: "text-sm font-medium text-foreground",
  text: "text-xs text-muted-foreground",
  actions: "flex flex-wrap items-center gap-2",
  primary: "inline-flex h-8 items-center rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground",
  secondary: "inline-flex h-8 items-center rounded-md border border-border px-3 text-sm font-medium text-foreground",
};

export function FirefliesServerImport({
  controller,
  classes = MEETING_SOURCES_CLASSES,
}: {
  controller: UseFirefliesServerImport;
  classes?: FirefliesServerImportClasses;
}) {
  const { view, turnOn, turnOff, retry } = controller;
  const [dismissed, setDismissed] = useState(false);
  const [confirmingOff, setConfirmingOff] = useState(false);
  if (view.phase === "hidden" || view.phase === "loading") return null;
  const date = firefliesImportDate(view.expiresAt);
  const working = view.phase === "working";

  const button = (label: string, kind: "primary" | "secondary", onClick: () => void) => (
    <button type="button" className={classes[kind]} aria-disabled={working} onClick={() => { if (!working) onClick(); }}>
      {label}
    </button>
  );

  let body;
  if (view.phase === "off" || view.phase === "working") {
    if (dismissed && view.phase === "off") return null;
    body = (
      <>
        {FIREFLIES_IMPORT_OFF_BODY.map((paragraph) => (
          <p key={paragraph} className={classes.text}>{paragraph}</p>
        ))}
        <div className={classes.actions}>
          {button(working ? "Turning on…" : FIREFLIES_IMPORT_TURN_ON, "primary", turnOn)}
          {button(FIREFLIES_IMPORT_NOT_NOW, "secondary", () => setDismissed(true))}
        </div>
      </>
    );
  } else if (view.phase === "on" || view.phase === "ending-soon") {
    body = confirmingOff ? (
      <>
        <p className={classes.text}>{FIREFLIES_IMPORT_TURN_OFF_CONFIRM}</p>
        <div className={classes.actions}>
          {button(FIREFLIES_IMPORT_TURN_OFF, "primary", () => { setConfirmingOff(false); turnOff(); })}
          {button(FIREFLIES_IMPORT_CANCEL, "secondary", () => setConfirmingOff(false))}
        </div>
      </>
    ) : (
      <>
        <p className={classes.text}>
          {view.phase === "on" ? firefliesImportOnLine(date) : firefliesImportEndingSoonLine(date)}
        </p>
        <div className={classes.actions}>
          {view.phase === "ending-soon" && button(FIREFLIES_IMPORT_KEEP_ON, "primary", turnOn)}
          {button(FIREFLIES_IMPORT_TURN_OFF, "secondary", () => setConfirmingOff(true))}
        </div>
      </>
    );
  } else if (view.phase === "paused") {
    body = (
      <>
        <p className={classes.text}>{FIREFLIES_IMPORT_PAUSED_LINE}</p>
        <div className={classes.actions}>{button(FIREFLIES_IMPORT_TURN_ON, "primary", turnOn)}</div>
      </>
    );
  } else if (view.phase === "off-unconfirmed") {
    body = (
      <>
        <p className={classes.text} role="alert">{firefliesImportUnconfirmedLine(date)}</p>
        <div className={classes.actions}>{button(FIREFLIES_IMPORT_TRY_AGAIN, "primary", turnOff)}</div>
      </>
    );
  } else if (view.phase === "needs-sign-in") {
    body = (
      <p className={classes.text} role="alert">
        {view.expiresAt ? firefliesImportSignInLine(date) : FIREFLIES_IMPORT_SIGN_IN_TO_TURN_ON_LINE}
      </p>
    );
  } else {
    body = (
      <>
        <p className={classes.text} role="alert">{FIREFLIES_IMPORT_UNAVAILABLE_LINE}</p>
        <div className={classes.actions}>{button(FIREFLIES_IMPORT_TRY_AGAIN, "primary", retry)}</div>
      </>
    );
  }

  return (
    <section className={classes.root} aria-label={FIREFLIES_IMPORT_HEADING} data-phase={view.phase} data-testid="fireflies-server-import">
      <div className={classes.copy}>
        <b className={classes.heading}>{FIREFLIES_IMPORT_HEADING}</b>
        {body}
      </div>
    </section>
  );
}

/**
 * The row with its own state, for a host that already knows Fireflies is connected and instant updates are on.
 * Mounting it is what turns the server read on; nothing is read or signed while it is not mounted.
 */
export function FirefliesServerImportHost({
  tcw,
  backendUrl,
  sessionStore,
  classes,
}: {
  tcw: TinyCloudWeb;
  backendUrl: string;
  sessionStore: SessionStore;
  classes?: FirefliesServerImportClasses;
}) {
  const controller = useFirefliesServerImport({ tcw, backendUrl, sessionStore, active: true });
  return <FirefliesServerImport controller={controller} classes={classes} />;
}
