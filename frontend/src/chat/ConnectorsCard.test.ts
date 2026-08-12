// Wiring tests for the connectors card's background-notifications half (FE3).
//
// `ConnectorsCard.tsx` itself cannot be imported here: its dialog chain pulls in
// `@tinycloud/web-sdk`, which evaluates browser globals (`HTMLElement`) that a
// bun test process does not have. So the card's one DECISION —  which row gets
// the surface — lives in `backgroundSyncState.ts` where it is directly
// testable, and the plumbing around it is asserted against the source, the same
// way the backend's deploy-env tests assert their compose files.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { supportsBackgroundNotifications } from "./backgroundSyncState";
import { CONNECTORS } from "@/lib/connectors/registry";
import type { ConnectorConnection } from "@/lib/connectors/types";

const fireflies = CONNECTORS.find((c) => c.id === "fireflies")!;
const granola = CONNECTORS.find((c) => c.id === "granola")!;

function connection(patch: Partial<ConnectorConnection> = {}): ConnectorConnection {
  return {
    connectorId: "fireflies",
    status: "connected",
    lastSyncedAt: null,
    lastSyncStatus: null,
    lastSyncError: null,
    itemCount: 0,
    ...patch,
  };
}

const CHAT_DIR = join(import.meta.dir);
const read = (name: string) => readFileSync(join(CHAT_DIR, name), "utf8");

describe("supportsBackgroundNotifications", () => {
  test("offers the surface on a CONNECTED Fireflies row", () => {
    expect(supportsBackgroundNotifications(fireflies, connection())).toBe(true);
  });

  test("does not offer it before the connector is connected", () => {
    expect(supportsBackgroundNotifications(fireflies, null)).toBe(false);
    expect(
      supportsBackgroundNotifications(fireflies, connection({ status: "disconnected" })),
    ).toBe(false);
  });

  test("does not offer it for a source the delivery route does not know", () => {
    expect(
      supportsBackgroundNotifications(granola, connection({ connectorId: "granola" })),
    ).toBe(false);
  });
});

describe("Settings composition", () => {
  test("SettingsPage hands the card the backendUrl and sessionStore it already has", () => {
    const settings = read("SettingsPage.tsx");
    const usage = settings.slice(settings.indexOf("<ConnectorsCard"));
    expect(usage).toContain("backendUrl={backendUrl}");
    expect(usage).toContain("sessionStore={sessionStore}");
  });

  test("the card builds BOTH typed clients from those props — no new globals", () => {
    // Two companion clients now — the webhooks write/config surface and the
    // cohort-gated meetings read surface (F011's consent probe) — and both
    // come from the same two props SettingsPage hands down. Still no
    // module-level singletons, still no other transport.
    const card = read("ConnectorsCard.tsx");
    expect(card).toContain("createConnectorWebhooksClient(backendUrl, { sessionStore })");
    expect(card).toContain("createConnectorMeetingsClient(backendUrl, { sessionStore })");
    expect(card).toContain("supportsBackgroundNotifications(d, rows[d.id].connection)");
    expect(card).toContain("<BackgroundSyncSection");
  });

  test("the card hands the background-sync section the meetings client", () => {
    // The section's mount probe is what selects the consent variant (F011);
    // the card only builds the client and passes it down — constructing it
    // performs no I/O, so a settings-page open still makes no extra request
    // by itself.
    const card = read("ConnectorsCard.tsx");
    const usage = card.slice(card.indexOf("<BackgroundSyncSection"));
    expect(usage).toContain("meetings={meetings}");
  });

  test("the surface never hand-rolls a request or persists anything", () => {
    for (const name of [
      "ConnectorsCard.tsx",
      "BackgroundSyncSection.tsx",
      "backgroundSyncState.ts",
    ]) {
      const source = read(name);
      // FE0's client is the only transport, and the delivery URL/secret never
      // reach storage — both are contract, not style.
      expect(source).not.toMatch(/\bfetch\s*\(/);
      expect(source).not.toContain("localStorage");
      expect(source).not.toContain("sessionStorage");
    }
  });

  test("the consent checkbox exists only for the B-ingest cohort variant", () => {
    // How this assertion evolved: Option B's checkbox died with Option B —
    // under C nothing is granted, so there was nothing to attest to, and this
    // test used to pin the source at ZERO checkboxes. B-ingest (residual
    // F011) legitimately changes that: for a cohort address the server DOES
    // hold a credential and meeting copies, so its checkbox is a live consent
    // mechanic gating the enable action — not a resurrected dead control.
    // The spirit survives precisely: the C path is intact, the cohort path
    // exists, and EXACTLY ONE checkbox is in the source, so no dormant
    // C-side twin can creep back. That the C-rendered MARKUP still carries no
    // checkbox is asserted in BackgroundSyncSection.test.tsx.
    const source = read("BackgroundSyncSection.tsx");
    expect(source).toContain("BACKGROUND_SYNC_CONSENT_COPY");
    expect(source).toContain("BACKEND_INGEST_CONSENT_COPY");
    expect(source.match(/type="checkbox"/g)).toHaveLength(1);
  });
});

// ── Teardown wiring (FE4) ────────────────────────────────────────────
//
// `ConnectorDialog.tsx` cannot be imported here either — same `@tinycloud/web-sdk`
// browser-global problem — so the DECISIONS live in `connectorLifecycle.ts`,
// which has its own suite, and what is asserted here is that the dialog
// actually delegates to it instead of keeping the old key-only teardown.

describe("disconnect wiring", () => {
  test("the card hands the disconnect dialog the webhooks client", () => {
    const card = read("ConnectorsCard.tsx");
    const usage = card.slice(card.indexOf("<ConnectorDisconnectDialog"));
    expect(usage).toContain("webhooks={webhooks}");
  });

  test("the card carries the mount-time dark verdict into the teardown", () => {
    // A per-call 404 must not be read as "the feature is off": only the
    // section's `GET /config` probe establishes that, and the dialog needs it
    // to decide whether skipping the tombstone/teardown is honest.
    const card = read("ConnectorsCard.tsx");
    expect(card).toContain("onFeatureDark={setFeatureDark}");
    const usage = card.slice(card.indexOf("<ConnectorDisconnectDialog"));
    expect(usage).toContain("featureDark={featureDark}");
    expect(read("ConnectorDialog.tsx")).toContain("featureDark: featureDark === true");
  });

  test("the dialog runs the ordered teardown rather than deleting the key itself", () => {
    const dialog = read("ConnectorDialog.tsx");
    expect(dialog).toContain("runDisconnect");
    expect(dialog).toContain("disconnectRetry");
    // The v1 path — await the key delete, then maybe purge — is gone from the
    // disconnect half: those are now dependencies the orchestrator sequences,
    // never steps the dialog performs in its own order.
    const disconnectHalf = dialog.slice(dialog.indexOf("ConnectorDisconnectDialog"));
    expect(disconnectHalf).not.toContain("await deleteConnectorKey");
    expect(disconnectHalf).not.toContain("await connectorStore.purgeConnector");
    expect(disconnectHalf).not.toContain("await connectorStore.updateSyncState");
  });

  test("the dialog reports success only from the orchestrator's done flag", () => {
    const dialog = read("ConnectorDialog.tsx");
    const disconnectHalf = dialog.slice(dialog.indexOf("ConnectorDisconnectDialog"));
    expect(disconnectHalf).toContain(".done");
  });

  test("no teardown or connect path clears the purge ledger", () => {
    // Clearing it is the explicit, separately-confirmed historical re-sync.
    for (const name of ["ConnectorDialog.tsx", "ConnectorsCard.tsx"]) {
      expect(read(name)).not.toContain("clearPurgeLedger");
    }
  });

  test("reconnecting does not touch the purge ledger or the webhook config", () => {
    const dialog = read("ConnectorDialog.tsx");
    const connectHalf = dialog.slice(
      dialog.indexOf("ConnectorConnectDialog"),
      dialog.indexOf("ConnectorDisconnectDialogProps"),
    );
    expect(connectHalf).not.toContain("clearPurgeLedger");
    expect(connectHalf).not.toContain("recordPurge");
    expect(connectHalf).not.toContain("webhooks.");
  });
});
