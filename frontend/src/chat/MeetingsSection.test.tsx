// RED-first component tests for the COHORT MEETINGS VIEW (backend-ingest plan
// §8.1 W5) — the surface where "your meetings are there even if you never opened
// the app" is finally something a user can see.
//
// `MeetingsView` is the whole rendered surface and a pure function of the state
// `meetingsView.ts` produces, so every product rule is asserted against real
// markup. The renderer is `react-dom/server`: the frontend workspace has no DOM
// test harness and adding one would mean new dependencies in a shared dirty tree
// (the same call BackgroundSyncSection.test.tsx made). The stateful wrapper's
// plumbing is asserted against the source, like ConnectorsCard.test.ts does.
//
// The rules:
//
//   1. DARK renders NOTHING — the flag is off or this address is not in the
//      cohort, and a non-cohort user must not learn the surface exists;
//   2. an outage is TOLD, never rendered as "no meetings" — the backend answers
//      503 instead of `[]` precisely so this view cannot tell that lie;
//   3. a reconciled meeting renders ONCE (the server copy and the user-space
//      copy are the same meeting, merged by `(source, sourceId)`);
//   4. no vault, no key: the section takes a session and a backend URL and
//      nothing else — no `tcw`, no secrets helper, no Fireflies client;
//   5. the drain-UX wiring in App.tsx is untouched by the meetings wiring.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

import { MeetingsView, type OpenMeetingState } from "./MeetingsSection";
import {
  applyListResult,
  applyLocalMeetings,
  initialMeetingsViewState,
  summaryText,
  transcriptText,
  type MeetingsViewState,
} from "@/lib/connectors/meetingsView";
import type { ConnectorMeetingMeta } from "@/lib/connectors/meetingsApi";

const SOURCE = "fireflies";

function meta(patch: Partial<ConnectorMeetingMeta> = {}): ConnectorMeetingMeta {
  return {
    sourceId: "mtg-1",
    title: "Q3 planning sync",
    ts: "2026-08-09T09:00:00.000Z",
    sizeBytes: 2048,
    storedAt: "2026-08-09T09:05:00.000Z",
    updatedAt: "2026-08-09T09:05:00.000Z",
    hasTranscript: true,
    hasSummary: true,
    ...patch,
  };
}

function ready(
  meetings: ConnectorMeetingMeta[],
  patch: { hasMore?: boolean; nextCursor?: string | null } = {},
): MeetingsViewState {
  return applyListResult(initialMeetingsViewState(SOURCE), {
    status: "ok",
    value: {
      source: SOURCE,
      meetings,
      nextCursor: patch.nextCursor ?? null,
      hasMore: patch.hasMore ?? false,
    },
  });
}

const noop = () => {};

function render(
  state: MeetingsViewState,
  open: OpenMeetingState | null = null,
): string {
  return renderToStaticMarkup(
    <MeetingsView
      state={state}
      connectorName="Fireflies"
      open={open}
      onRefresh={noop}
      onLoadMore={noop}
      onOpen={noop}
      onClose={noop}
    />,
  );
}

describe("MeetingsView", () => {
  test("renders NOTHING when the feature is dark for this address", () => {
    const dark = applyListResult(initialMeetingsViewState(SOURCE), {
      status: "feature-dark",
    });
    expect(render(dark)).toBe("");
  });

  test("lists the meetings the backend already holds", () => {
    const html = render(
      ready([
        meta({ sourceId: "mtg-1", title: "Q3 planning sync" }),
        meta({ sourceId: "mtg-2", title: "Board prep", ts: "2026-08-08T09:00:00.000Z" }),
      ]),
    );
    expect(html).toContain("Q3 planning sync");
    expect(html).toContain("Board prep");
    expect(html).not.toContain("No meetings");
  });

  test("a reconciled meeting renders ONCE — the two copies are one meeting", () => {
    const server = ready([
      meta({ sourceId: "mtg-1", reconciledAt: "2026-08-09T10:00:00.000Z" }),
    ]);
    const both = applyLocalMeetings(server, [
      { source: SOURCE, sourceId: "mtg-1", title: "Q3 planning sync" },
    ]);
    const html = render(both);
    expect(both.meetings).toHaveLength(1);
    expect(html.split("Q3 planning sync").length - 1).toBe(1);
  });

  test("a meeting that exists only in the user's own space still renders", () => {
    const local = applyLocalMeetings(ready([]), [
      { source: SOURCE, sourceId: "mtg-local", title: "Synced before the cohort" },
    ]);
    expect(render(local)).toContain("Synced before the cohort");
  });

  test("an outage is told, never rendered as an empty archive", () => {
    const down = applyListResult(ready([]), {
      status: "retryable",
      httpStatus: 503,
      code: "unavailable",
    });
    const html = render(down);
    expect(html).not.toContain("No meetings");
    expect(html.toLowerCase()).toContain("unavailable");
    // A retryable failure offers the retry rather than leaving a dead surface.
    expect(html.toLowerCase()).toContain("try again");
  });

  test("offline and signed-out are their own states", () => {
    expect(render(applyListResult(ready([]), { status: "offline" })).toLowerCase()).toContain(
      "offline",
    );
    const out = render(
      applyListResult(ready([]), { status: "unauthenticated" }),
    ).toLowerCase();
    expect(out).toContain("sign in");
  });

  test("an EMPTY archive says so — and that copy appears nowhere else", () => {
    expect(render(ready([]))).toContain("No meetings");
  });

  test("a summary-only meeting says which half arrived", () => {
    const html = render(
      ready([meta({ hasTranscript: false, hasSummary: true })]),
    );
    expect(html).toContain("Summary only");
  });

  test("the 'load more' control appears only when a page was truncated", () => {
    expect(render(ready([meta()], { hasMore: true, nextCursor: "mtg-1" }))).toContain(
      "Load more",
    );
    expect(render(ready([meta()]))).not.toContain("Load more");
  });

  test("an opened meeting renders its content; a vanished one says so", () => {
    const state = ready([meta()]);
    const open: OpenMeetingState = {
      sourceId: "mtg-1",
      status: "ready",
      content: {
        source: SOURCE,
        sourceId: "mtg-1",
        meta: meta(),
        content: { summary: { overview: "Legal review blocks the Q3 plan" } },
      },
    };
    expect(render(state, open)).toContain("Legal review blocks the Q3 plan");

    const gone = render(state, { sourceId: "mtg-1", status: "missing" });
    expect(gone.toLowerCase()).toContain("no longer");
  });
});

describe("meeting text extraction", () => {
  test("reads the Fireflies summary shapes and falls back to the raw payload", () => {
    expect(summaryText({ summary: "plain string" })).toBe("plain string");
    expect(summaryText({ summary: { overview: "an overview" } })).toBe("an overview");
    expect(summaryText({ summary: { short_summary: "a short one" } })).toBe("a short one");
    expect(summaryText({})).toBe(null);
  });

  test("joins transcript sentences and tolerates a plain string", () => {
    expect(
      transcriptText({
        transcript: { sentences: [{ text: "one" }, { text: "two" }] },
      }),
    ).toBe("one\ntwo");
    expect(transcriptText({ transcript: "raw text" })).toBe("raw text");
    expect(transcriptText({})).toBe(null);
  });
});

// ── Plumbing (source assertions — the house idiom for what a bun test cannot boot) ──

describe("MeetingsSection wiring", () => {
  const SECTION = readFileSync(join(import.meta.dir, "MeetingsSection.tsx"), "utf8");

  test("holds no key material and no storage handle — a session is all it takes", () => {
    expect(SECTION).toContain("createConnectorMeetingsClient");
    expect(SECTION).not.toContain("connectorSecrets");
    expect(SECTION).not.toContain("FirefliesClient");
    expect(SECTION).not.toContain("TinyCloudWeb");
    expect(SECTION).not.toContain("localStorage");
    // No identifier reaches the browser console from this surface (§6.3's browser half).
    expect(SECTION).not.toContain("console.");
  });

  test("reads the API on mount and pages with the server's own cursor", () => {
    expect(SECTION).toContain("useEffect");
    expect(SECTION).toMatch(/\.list\(/);
    expect(SECTION).toContain("nextCursor");
    // The reconcile-ack belongs to W6 (it must follow a user-space write), so the
    // read-only view never calls it.
    expect(SECTION).not.toContain("markReconciled");
  });
});

describe("App.tsx wiring", () => {
  const APP = readFileSync(join(import.meta.dir, "..", "App.tsx"), "utf8");
  const CONNECTORS = readFileSync(join(import.meta.dir, "ConnectorsPage.tsx"), "utf8");

  test("App constructs the meetings view with a session and a backend URL only", () => {
    expect(APP).toContain("MeetingsSection");
    expect(APP).toMatch(/<MeetingsSection[\s\S]{0,240}backendUrl=\{BACKEND_URL\}/);
    expect(APP).toMatch(/<MeetingsSection[\s\S]{0,240}sessionStore=\{sessionStoreRef\.current\}/);
    // The point of the read API: it works on a device with no vault.
    expect(APP).not.toMatch(/<MeetingsSection[\s\S]{0,240}tcw=\{/);
  });

  test("ConnectorsPage renders the slot App hands it", () => {
    expect(CONNECTORS).toContain("meetingsSlot");
  });

  test("the drain-UX wiring App already had is untouched", () => {
    // The meetings view is ADDITIVE. The Option-C badge and the sign-out clear
    // are what the frozen drain-UX files depend on from App.tsx.
    expect(APP).toContain("clearBackgroundDrainRecord");
    expect(APP).toContain("subscribeBackgroundDrainRecord");
    expect(APP).toContain("badgePendingCount");
    expect(APP).toContain("<BackgroundDrainer");
  });
});
