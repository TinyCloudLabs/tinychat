// RED-first component tests for the background-notifications surface (FE3).
//
// `BackgroundSyncView` is the whole rendered surface: a pure function of the
// state `backgroundSyncState.ts` produces, so every product rule the handoff
// states about what the user SEES is asserted here against real markup.
//
// The renderer is `react-dom/server` — the frontend workspace has no DOM test
// harness, and adding one would mean new dependencies in a shared dirty tree.
// Everything interactive is therefore split so it stays testable: the handlers
// are props (asserted by the model suite, which owns the click behaviour) and
// the view is asserted for what it renders in each state.

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { BackgroundSyncView, consentVariantForProbe } from "./BackgroundSyncSection";
import {
  HISTORICAL_RESYNC_CONFIRM_COPY,
  applyEnableResult,
  dismissReveal,
  initialBackgroundSyncState,
  type BackgroundSyncState,
} from "./backgroundSyncState";
import type { ConnectorWebhookEnabled } from "@/lib/connectors/webhooksApi";

const DELIVERY_URL = "https://api.example.test/api/connectors/webhooks/fireflies/tok_abc";
const DELIVERY_SECRET = "AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHIIIIJJJJKKK";

function minted(patch: Partial<ConnectorWebhookEnabled> = {}): ConnectorWebhookEnabled {
  return {
    status: "enabled",
    rotated: false,
    enabled: true,
    disabledAt: null,
    source: "fireflies",
    url: DELIVERY_URL,
    secret: DELIVERY_SECRET,
    hasSecret: true,
    createdAt: "2026-08-06T10:00:00.000Z",
    ...patch,
  };
}

const noop = () => {};

function render(state: BackgroundSyncState): string {
  return renderToStaticMarkup(
    <BackgroundSyncView
      state={state}
      connectorName="Fireflies"
      onEnable={noop}
      onRotate={noop}
      onDisable={noop}
      onSync={noop}
      onRetry={noop}
      onDismissReveal={noop}
      onCopy={noop}
      onRequestHistoricalResync={noop}
      onCancelHistoricalResync={noop}
      onConfirmHistoricalResync={noop}
    />,
  );
}

function enabledState(patch: Partial<BackgroundSyncState> = {}): BackgroundSyncState {
  return {
    ...initialBackgroundSyncState(),
    phase: "enabled",
    hasSecret: true,
    revealClosed: true,
    queue: { pendingCount: 0, deadCount: 0, rateLimited: false, blockedReason: null },
    ...patch,
  };
}

// Markup → text, so assertions read the copy and not the class soup.
function text(html: string): string {
  return html.replace(/<[^>]*>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();
}

describe("feature-dark and loading", () => {
  test("a dark route renders NOTHING — not a broken setup control", () => {
    const html = render({ ...initialBackgroundSyncState(), phase: "dark" });
    expect(html).toBe("");
  });

  test("the first load renders neither an off state nor a queue claim", () => {
    const body = text(render(initialBackgroundSyncState()));
    expect(body.toLowerCase()).not.toContain("nothing waiting");
    expect(body).not.toContain("Enabled in TinyChat");
  });
});

describe("the off state", () => {
  const off = render({ ...initialBackgroundSyncState(), phase: "off" });

  test("offers turning background notifications on, as an OPTIONAL extra", () => {
    expect(text(off)).toContain("Background notifications");
    expect(text(off).toLowerCase()).toContain("optional");
    expect(off).toContain("Turn on background notifications");
  });

  test("is honest about Option C: the fetch happens on your next visit", () => {
    const body = text(off).toLowerCase();
    expect(body).toContain("next visit");
    // Verbatim from the shipped Option-C consent copy — the renderer may not
    // paraphrase it, so the assertion quotes it.
    expect(body).toContain("never sees your fireflies key");
    // The one claim we must NOT make.
    expect(body).not.toContain("fully offline");
    expect(body).not.toContain("even while you are away");
  });

  test("says the server is granted no permission on the space", () => {
    expect(text(off).toLowerCase()).toContain("no new permission");
  });

  test("shows no delivery URL, secret or queue while it is off", () => {
    expect(off).not.toContain(DELIVERY_URL);
    expect(off).not.toContain(DELIVERY_SECRET);
    expect(text(off)).not.toContain("Enabled in TinyChat");
  });
});

// ── The cohort off state — residual F011 ─────────────────────────────
//
// For an address the backend-ingest probe affirms, Option C's custody
// sentences are FALSE (the server does hold a credential, does receive the
// meeting), so the off state renders the pinned B-ingest text instead, with a
// live attestation checkbox gating the enable action. The view is rendered
// directly with the new props here; the container's probe → variant mapping is
// the pure function asserted in its own block below. The `render` helper above
// stays untouched — it passes none of the consent props, so every frozen
// Option-C assertion keeps exercising the default (non-cohort) path.

function renderCohort(
  state: BackgroundSyncState,
  props: { consentVariant?: "C" | "B-ingest"; ingestConsentChecked?: boolean } = {},
): string {
  return renderToStaticMarkup(
    <BackgroundSyncView
      state={state}
      connectorName="Fireflies"
      consentVariant={props.consentVariant}
      ingestConsentChecked={props.ingestConsentChecked}
      onIngestConsentChange={noop}
      onEnable={noop}
      onRotate={noop}
      onDisable={noop}
      onSync={noop}
      onRetry={noop}
      onDismissReveal={noop}
      onCopy={noop}
      onRequestHistoricalResync={noop}
      onCancelHistoricalResync={noop}
      onConfirmHistoricalResync={noop}
    />,
  );
}

/** The enable button's own tag — attributes only — so a `disabled:` Tailwind
 *  class or a disabled control elsewhere can never satisfy the assertion. */
function enableButtonMarkup(html: string): string {
  const label = html.indexOf(">Turn on background notifications<");
  expect(label).toBeGreaterThan(-1);
  return html.slice(html.lastIndexOf("<button", label), label);
}

describe("the cohort off state (B-ingest)", () => {
  const offState = (): BackgroundSyncState => ({
    ...initialBackgroundSyncState(),
    phase: "off",
  });
  const cohortOff = renderCohort(offState(), { consentVariant: "B-ingest" });

  test("renders the cohort copy — server-side custody said plainly", () => {
    const body = text(cohortOff);
    expect(body).toContain("Background sync (server-side ingestion)");
    // Bullet 1's breach disclosure, a sentence Option C never needed.
    expect(body).toContain("If our server is breached");
    // The attestation sentence is on screen as the checkbox label.
    expect(body).toContain("full-account Fireflies token");
  });

  test("contains NONE of the retired Option-C custody sentences", () => {
    const body = text(cohortOff).toLowerCase();
    expect(body).not.toContain("never sees your fireflies key");
    expect(body).not.toContain("it never receives the meeting itself");
  });

  test("the disconnect note renders, below the bullets that point at it", () => {
    const body = text(cohortOff);
    expect(body).toContain("Disconnecting undoes all of it");
    expect(body.indexOf("Disconnecting undoes all of it")).toBeGreaterThan(
      body.indexOf("see below"),
    );
  });

  test("a real checkbox exists under B-ingest — and does NOT exist under C", () => {
    expect(cohortOff).toContain('type="checkbox"');
    // The default render is the non-cohort path: Option B's checkbox stays
    // dead there — no permission is granted under C, so nothing to attest to.
    expect(render(offState())).not.toContain('type="checkbox"');
  });

  test("the enable action is inert until the attestation is checked", () => {
    expect(enableButtonMarkup(cohortOff)).toContain('disabled=""');
    const checked = renderCohort(offState(), {
      consentVariant: "B-ingest",
      ingestConsentChecked: true,
    });
    expect(enableButtonMarkup(checked)).not.toContain('disabled=""');
  });

  test("an explicit variant 'C' renders byte-identically to the default", () => {
    expect(renderCohort(offState(), { consentVariant: "C" })).toBe(render(offState()));
  });
});

describe("consentVariantForProbe — the fail-closed matrix", () => {
  test("only an affirmative ok selects the cohort copy", () => {
    expect(consentVariantForProbe({ status: "ok" })).toBe("B-ingest");
  });

  test("every non-ok answer — and no answer at all — is Option C", () => {
    const nonAffirmative = [
      { status: "feature-dark" }, // the not-in-cohort 404
      { status: "unauthenticated" },
      { status: "offline" },
      { status: "retryable" },
      { status: "rejected" },
      null,
      undefined,
    ];
    for (const answer of nonAffirmative) {
      expect(consentVariantForProbe(answer)).toBe("C");
    }
  });
});

describe("the one-time reveal", () => {
  const revealed = render(applyEnableResult(initialBackgroundSyncState(), minted()));

  test("shows the delivery URL and the signing secret with explicit copy controls", () => {
    expect(revealed).toContain(DELIVERY_URL);
    expect(revealed).toContain(DELIVERY_SECRET);
    expect(revealed).toContain("Copy delivery URL");
    expect(revealed).toContain("Copy signing secret");
  });

  test("tells the user this is the only time the secret is shown", () => {
    const body = text(revealed).toLowerCase();
    expect(body).toContain("only time");
    expect(body).toContain("rotate");
  });

  test("directs the user to Fireflies Webhooks V2 and the supported events", () => {
    const body = text(revealed);
    expect(body).toContain("Webhooks V2");
    expect(body).toContain("meeting.transcribed");
    expect(body).toContain("meeting.summarized");
  });

  test("has an explicit control that closes the reveal", () => {
    expect(text(revealed)).toContain("I've saved these");
  });

  test("labels the status 'Enabled in TinyChat' and never 'Live'", () => {
    // The status word is asserted on its own marked-up element: a substring
    // search for "live" would also match "delivery URL", which the reveal
    // legitimately says.
    expect(revealed).toContain('data-status-label="Enabled in TinyChat"');
    expect(revealed).not.toContain('data-status-label="Live"');
  });

  test("a rotation says the previous URL and secret have stopped working", () => {
    const rotated = render(
      applyEnableResult(initialBackgroundSyncState(), minted({ rotated: true })),
    );
    const body = text(rotated).toLowerCase();
    expect(body).toContain("stopped working");
    expect(body).toContain("replace");
  });
});

describe("after the reveal is closed", () => {
  const closed = render(dismissReveal(applyEnableResult(initialBackgroundSyncState(), minted())));

  test("neither the URL nor the secret is anywhere in the markup", () => {
    expect(closed).not.toContain(DELIVERY_URL);
    expect(closed).not.toContain(DELIVERY_SECRET);
  });

  test("offers the rotate recovery path and explains its cost", () => {
    expect(closed).toContain("Rotate webhook credentials");
    const body = text(closed).toLowerCase();
    expect(body).toContain("stop working");
    expect(body).toContain("fireflies");
  });

  test("still offers turning background notifications back off", () => {
    expect(closed).toContain("Turn off background notifications");
  });
});

describe("queue states", () => {
  test("pending work is a count plus a user-initiated sync action", () => {
    const html = render(
      enabledState({ queue: { pendingCount: 3, deadCount: 0, rateLimited: false, blockedReason: null } }),
    );
    expect(text(html)).toContain("3 meetings waiting");
    expect(html).toContain("Sync queued meetings");
  });

  test("a dead-letter is its own visible state, even with nothing pending", () => {
    const html = render(
      enabledState({ queue: { pendingCount: 0, deadCount: 2, rateLimited: false, blockedReason: null } }),
    );
    const body = text(html).toLowerCase();
    expect(body).toContain("2");
    expect(body).toContain("gave up");
    expect(body).not.toContain("nothing waiting");
  });

  test("a rate-limited state is named, not hidden behind an empty queue", () => {
    const html = render(
      enabledState({ queue: { pendingCount: 0, deadCount: 0, rateLimited: true, blockedReason: null } }),
    );
    const body = text(html).toLowerCase();
    expect(body).toContain("rate");
    expect(body).not.toContain("nothing waiting");
  });

  test("a fail-closed surfaceBlocked is actionable, never an empty queue", () => {
    const html = render(
      enabledState({
        queue: { pendingCount: 0, deadCount: 0, rateLimited: false, blockedReason: "ledger_unavailable" },
      }),
    );
    const body = text(html).toLowerCase();
    expect(body).toContain("can't show");
    expect(body).not.toContain("nothing waiting");
    expect(html).toContain("Check again");
  });

  test("a queue outage says unavailable and offers a retry", () => {
    const html = render(enabledState({ queue: null, queueUnavailable: true }));
    const body = text(html).toLowerCase();
    expect(body).toContain("unavailable");
    expect(body).not.toContain("nothing waiting");
    expect(html).toContain("Check again");
  });

  test("an empty queue is allowed to say so", () => {
    expect(text(render(enabledState())).toLowerCase()).toContain("nothing waiting");
  });
});

describe("locked secrets", () => {
  test("pending work with a locked vault offers the unlock as a user action", () => {
    const html = render(
      enabledState({
        ingestBlocked: "secrets-locked",
        queue: { pendingCount: 2, deadCount: 0, rateLimited: false, blockedReason: null },
      }),
    );
    expect(html).toContain("Sync queued meetings");
    expect(text(html).toLowerCase()).toContain("unlock");
  });
});

describe("outages", () => {
  test("a backend outage renders unavailable + retry, never 'off' and never success", () => {
    const html = render({
      ...initialBackgroundSyncState(),
      phase: "unavailable",
      notice: { tone: "error", message: "Background notifications are temporarily unavailable.", retryable: true },
    });
    const body = text(html).toLowerCase();
    expect(body).toContain("unavailable");
    expect(body).not.toContain("enabled in tinychat");
    expect(html).toContain("Try again");
  });

  test("a signed-out surface asks for sign-in rather than claiming a state", () => {
    const body = text(render({ ...initialBackgroundSyncState(), phase: "signed-out" })).toLowerCase();
    expect(body).toContain("sign in");
    expect(body).not.toContain("enabled in tinychat");
  });

  test("a retryable action notice renders with its retry affordance", () => {
    const html = render(
      enabledState({
        notice: { tone: "error", message: "Couldn't reach the server.", retryable: true },
      }),
    );
    expect(text(html)).toContain("Couldn't reach the server.");
    expect(html).toContain("Try again");
  });
});

describe("the last processing result", () => {
  test("reports what was stored and what stayed queued", () => {
    const html = render(
      enabledState({
        lastIngest: {
          stored: 2,
          acknowledged: 2,
          alreadySettled: 0,
          tombstoned: 0,
          failed: 1,
          unacknowledged: 0,
        },
        queue: { pendingCount: 1, deadCount: 0, rateLimited: false, blockedReason: null },
      }),
    );
    const body = text(html);
    expect(body).toContain("2");
    expect(body.toLowerCase()).toContain("saved");
    expect(body.toLowerCase()).toContain("still queued");
  });
});

// ── Allow historical re-sync (FE4) ───────────────────────────────────

describe("allow historical re-sync", () => {
  test("is offered as a separate, plainly-labelled action", () => {
    const html = render(enabledState());
    expect(text(html).toLowerCase()).toContain("deleted");
    expect(html).toContain(HISTORICAL_RESYNC_CONFIRM_COPY.heading);
  });

  test("does nothing destructive until it is confirmed", () => {
    // Un-armed: the explanation and the confirm control are simply absent.
    const html = render(enabledState());
    expect(html).not.toContain(HISTORICAL_RESYNC_CONFIRM_COPY.confirmLabel);
    expect(html).not.toContain(HISTORICAL_RESYNC_CONFIRM_COPY.body);
  });

  test("armed, it explains exactly what comes back and offers a way out", () => {
    const html = render(enabledState({ resyncConfirming: true }));
    expect(html).toContain(HISTORICAL_RESYNC_CONFIRM_COPY.body);
    expect(html).toContain(HISTORICAL_RESYNC_CONFIRM_COPY.confirmLabel);
    expect(html).toContain(HISTORICAL_RESYNC_CONFIRM_COPY.cancelLabel);
  });

  test("is not offered while the one-time secret is on screen", () => {
    const html = render(
      enabledState({
        revealClosed: false,
        reveal: { url: DELIVERY_URL, secret: DELIVERY_SECRET, rotated: false },
      }),
    );
    expect(html).not.toContain(HISTORICAL_RESYNC_CONFIRM_COPY.heading);
  });

  test("is not offered when background notifications are off", () => {
    const html = render({ ...initialBackgroundSyncState(), phase: "off" });
    expect(html).not.toContain(HISTORICAL_RESYNC_CONFIRM_COPY.heading);
  });
});
