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

  test("the Google teardown revokes upstream and skips the webhook half", () => {
    // One code path: revoke → secret wipe → local purge, all inside the same
    // run, with the two delivery-lane steps handed to the orchestrator already
    // complete (google-meet has no webhook, so there is nothing to disable and
    // no tombstone that could suppress anything).
    const disconnectHalf = read("ConnectorDialog.tsx").slice(
      read("ConnectorDialog.tsx").indexOf("ConnectorDisconnectDialogProps"),
    );
    expect(disconnectHalf).toContain("revokeGoogleUpstream");
    expect(disconnectHalf).toContain("GOOGLE_OAUTH_REVOKE_PATH");
    expect(disconnectHalf).toContain("WEBHOOKLESS_STEPS");
    expect(disconnectHalf).toContain("runDisconnect");
    // A failed upstream revoke is REPORTED, never swallowed and never a
    // dead end — the same promise the consent copy makes.
    expect(disconnectHalf).toContain("upstreamRevokeMessage");
  });

  test("no teardown or connect path clears the purge ledger", () => {
    // Clearing it is the explicit, separately-confirmed historical re-sync.
    for (const name of ["ConnectorDialog.tsx", "ConnectorsCard.tsx"]) {
      expect(read(name)).not.toContain("clearPurgeLedger");
    }
  });
});

// ── Google Meet OAuth connect variant (WP-C) ─────────────────────────
//
// Same reason as the block above: `ConnectorDialog.tsx` cannot be imported in a
// bun test process (its dialog chain evaluates browser globals), so what is
// asserted here is the SOURCE — and specifically the handful of properties that
// are silently broken rather than loudly broken when they regress. A popup
// opened one await too late still compiles; a listener that skips the origin
// check still connects.

describe("Google Meet OAuth connect variant", () => {
  const dialog = read("ConnectorDialog.tsx");
  // The OAuth machine only — the API-key machine shares the connect half and
  // has its own Fireflies-shaped strings that these assertions must not read.
  const connectHalf = dialog.slice(
    dialog.indexOf("// ── Connect (OAuth variant)"),
    dialog.indexOf("// ── Disconnect"),
  );

  test("selects the machine from the registry id, not from the secret name", () => {
    // The flip commit changes `secretName` on this same row; a predicate keyed
    // off that would move with it and pick the wrong machine mid-campaign.
    expect(dialog).toContain("usesOAuthConnect");
    expect(dialog).toContain("descriptor.id === GMEET_CONNECTOR_ID");
  });

  test("opens the popup synchronously from the click, then navigates it", () => {
    // The whole reason this handler is not `async`: a `window.open` that lands
    // after an await is blocked by default, and the user sees nothing happen.
    const handler = connectHalf.slice(
      connectHalf.indexOf("const handleAuthorize"),
      connectHalf.indexOf("const handleCancelAuthorize"),
    );
    expect(handler).toContain("useCallback(() => {");
    expect(handler.indexOf("window.open(")).toBeLessThan(handler.indexOf("await"));
    expect(handler).toContain("popup.location.href");
    // A blocked popup gets its own actionable state, not a silent no-op.
    expect(handler).toContain('kind: "popup-blocked"');
    expect(dialog).toContain("Allow popups for this site");
  });

  test("the callback listener checks BOTH the origin and the minted state", () => {
    expect(connectHalf).toContain("event.origin !== expectedOrigin");
    expect(connectHalf).toContain("state !== stateRef.current");
    // …and accepts nothing but `{ code, state }`.
    expect(connectHalf).toContain(
      'if (typeof code !== "string" || typeof state !== "string") return;',
    );
  });

  test("tokens never ride postMessage — only the authenticated exchange", () => {
    // The SPA only ever LISTENS; nothing here posts, and the token fields are
    // read from the exchange response alone.
    expect(dialog).not.toMatch(/\.postMessage\(/);
    expect(connectHalf).toContain("GOOGLE_OAUTH_EXCHANGE_PATH");
    expect(connectHalf).toContain("JSON.stringify({ code, verifier })");
    // The verifier is dropped before the response is even read.
    expect(connectHalf).toContain("verifierRef.current = null;");
  });

  test("persists the refresh token through the registry row, never a literal", () => {
    expect(connectHalf).toContain(
      "saveConnectorKey<SecretsErr>(tcw, descriptor, refreshToken)",
    );
    // The names live in registry.ts; spelling either one here would make the
    // flip commit a two-file change and this file a place they could drift.
    expect(connectHalf).not.toContain("REFRESH_TOKEN");
    expect(connectHalf).not.toContain("API_KEY");
  });

  test("carries the G3 weekly re-auth caveat, shipped hidden", () => {
    // Required LIVE in the dialog before testing mode opens beyond the team;
    // hidden by default because internal mode does not expire weekly, and a
    // warning that is currently false is its own dishonesty.
    expect(dialog).toContain("GOOGLE_TESTING_MODE_REAUTH_COPY");
    expect(dialog).toContain("SHOW_GOOGLE_TESTING_MODE_CAVEAT: boolean = false");
    expect(dialog).toContain("{SHOW_GOOGLE_TESTING_MODE_CAVEAT && (");
  });

  test("scopes the auto-transcription offer to meetings the user hosts", () => {
    expect(connectHalf).toContain("patchSpaceAutoTranscription");
    expect(connectHalf).toContain("Turn on transcription for meetings you host");
    // A 403 is expected host-only semantics — calm, not an error tone.
    expect(connectHalf).toContain('res.reason === "not-host"');
    expect(connectHalf).toContain("Only the meeting host can change this");
    // Declining is one click and costs nothing.
    expect(connectHalf).toContain("Not now");
  });

  test("tells Google's three failure reasons apart", () => {
    // Listen flattened these and could not say which had happened.
    for (const kind of ["reconnect-needed", "no-access", "slow-down"]) {
      expect(dialog).toContain(`case "${kind}":`);
    }
    expect(dialog).toContain('code === "invalid_grant"');
  });

  test("logs nothing at all from the connect flow", () => {
    // Codes, verifiers and tokens all pass through this file.
    expect(dialog).not.toMatch(/console\.(log|debug|info|warn|error)\(/);
  });

  test("the card hands both dialogs the backend props the OAuth flow needs", () => {
    // The connect dialog's exchange and the disconnect dialog's upstream revoke
    // are authenticated backend calls; neither may build a transport of its own.
    const card = read("ConnectorsCard.tsx");
    for (const marker of ["<ConnectorConnectDialog", "<ConnectorDisconnectDialog"]) {
      const usage = card.slice(card.indexOf(marker));
      expect(usage).toContain("backendUrl={backendUrl}");
      expect(usage).toContain("sessionStore={sessionStore}");
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

// ── "Sync now" engine dispatch (WP-C) ────────────────────────────────
//
// The trap this block closes, stated plainly: the card used to hardwire
// `FirefliesClient` + `syncFireflies` behind a single `d.id !== "fireflies"`
// guard, so a descriptor moving coming-soon → available WITHOUT its own
// dispatch entry would have fetched Google Meet data with the Fireflies client
// and the Fireflies key — a silent failure, not a loud one. Being an
// `INITIAL_ROW_STATE_MAP` key forces nothing (granola is one too): the dispatch
// below and the registry's `status` are the forcing functions.
//
// Asserted against the SOURCE for the reason this file's header already gives —
// `ConnectorsCard.tsx` cannot be imported into a bun test process. The engines
// themselves have injected-seam suites of their own (`gmeetSync.test.ts`,
// `useGmeetSessionSync.test.tsx`, `firefliesSync.test.ts`); what is only
// checkable here is WHICH one each row reaches, and with what.

describe("Sync now — engine dispatch", () => {
  const card = read("ConnectorsCard.tsx");
  const handler = card.slice(
    card.indexOf("const handleSyncNow"),
    card.indexOf("const handleStopSync"),
  );
  const gmeetEngine = card.slice(
    card.indexOf("async function runGmeetSyncNow"),
    card.indexOf("export function ConnectorsCard"),
  );
  const firefliesEngine = card.slice(
    card.indexOf("async function runFirefliesSyncNow"),
    card.indexOf("async function runGmeetSyncNow"),
  );

  test("dispatches on the registry id, with no shared default", () => {
    expect(handler).toContain('d.id === "fireflies"');
    expect(handler).toContain("d.id === GMEET_CONNECTOR_ID");
    // A row with no engine still lands on the explicit refusal.
    expect(handler).toContain("Sync not yet implemented for this connector.");
  });

  test("google-meet runs the Meet engine and NEVER the Fireflies client", () => {
    expect(gmeetEngine).toContain("new GmeetClient(");
    expect(gmeetEngine).toContain("syncGoogleMeet(");
    expect(gmeetEngine).toContain("mintGmeetAccessToken(");
    // The two things that would make this the very bug the dispatch exists to
    // prevent, had they leaked into the Meet branch.
    expect(gmeetEngine).not.toContain("FirefliesClient");
    expect(gmeetEngine).not.toContain("syncFireflies");
  });

  test("fireflies still runs the Fireflies engine, untouched", () => {
    expect(firefliesEngine).toContain("new FirefliesClient(");
    expect(firefliesEngine).toContain("syncFireflies(");
    expect(firefliesEngine).toContain("store: connectorStore");
    expect(firefliesEngine).not.toContain("GmeetClient(");
    expect(firefliesEngine).not.toContain("syncGoogleMeet(");
  });

  test("the Meet branch mints its token through the backend proxy, not a raw fetch", () => {
    // The card builds no transport of its own — `mintGmeetAccessToken` is the
    // one authenticated call, and the file-wide no-fetch rule above still holds.
    expect(gmeetEngine).toContain("backendUrl");
    expect(gmeetEngine).toContain("sessionStore");
    expect(card).not.toMatch(/\bfetch\s*\(/);
  });

  test("the refresh token comes from the registry row, never a literal", () => {
    // The flip commit changes `secretName` on that row; spelling it here would
    // make this file a place the two can drift.
    expect(handler).toContain("getConnectorKey<SecretsErr>(tcw, d)");
    expect(card).not.toContain("REFRESH_TOKEN");
    expect(card).not.toContain('"API_KEY"');
  });

  test("the existing vault-unlock gate is reused for BOTH engines", () => {
    // One unlock, above the branch — not a second copy inside the Meet engine,
    // and not skipped for it. (The engine is CHOSEN before the unlock; what
    // matters is that neither engine RUNS before it.)
    expect(handler.indexOf("isSecretsUnlocked(tcw)")).toBeLessThan(
      handler.indexOf('engine === "gmeet"'),
    );
    expect(gmeetEngine).not.toContain("unlockSecrets");
    expect(handler.match(/unlockSecrets<SecretsErr>\(tcw\)/g)).toHaveLength(1);
  });

  test("the Meet run shares the engine's single-flight and the row's Stop button", () => {
    // `syncGoogleMeet` owns a module-level in-flight slot shared with the
    // session-start lane, and the card threads its own AbortController into it
    // so Stop cancels between items — the same handle the Fireflies path uses.
    expect(handler).toContain("syncAbortRefs.current[d.id] = ac");
    expect(gmeetEngine).toContain("signal,");
  });

  test("a press that JOINS the session lane's run renders no dead Stop button", () => {
    // The joined caller's signal and onProgress are both ignored by the engine,
    // so a Stop button on that row would abort nothing and the bar would never
    // move. The row says where the run came from instead of pretending.
    expect(handler).toContain("isGmeetSyncInFlight()");
    expect(handler).toContain("joinedBackgroundSync: true");
    expect(card).toContain("state.joinedBackgroundSync ? null : (");
    expect(card).toContain("joined it rather than starting a second pass");
  });

  test("the connected Google Meet row exposes a separate Full rescan snapshot action only", () => {
    const row = card.slice(card.indexOf("const ConnectorRow"), card.indexOf("const ConnectedStatusLine"));
    expect(card).toContain('onFullRescan={() => handleSyncNow(d, "snapshot")}');
    expect(row).toContain("onFullRescan?: () => void");
    expect(row).toContain('d.id === GMEET_CONNECTOR_ID');
    expect(row).toContain("onClick={onFullRescan}");
    expect(row).toContain("Full rescan");
    expect(gmeetEngine).toContain('driveMode?: "auto" | "snapshot"');
    expect(gmeetEngine).toContain("driveMode: opts.driveMode");
  });

  test("Full rescan refuses an existing engine run before dispatch and disables both card-owned actions", () => {
    const guardStart = handler.indexOf('driveMode === "snapshot"');
    const guard = handler.slice(
      guardStart,
      handler.indexOf("syncing: true", guardStart),
    );
    expect(guard).toContain("isGmeetSyncInFlight()");
    expect(guard).toContain("Another Google Meet sync is already running. Try Full rescan again when it finishes.");
    expect(guard).toContain("return;");
    expect(guard).not.toContain("runGmeetSyncNow(");
    expect(handler.indexOf('driveMode === "snapshot"')).toBeLessThan(handler.indexOf("runGmeetSyncNow("));
    expect(card.match(/disabled=\{state\.syncing\}/g)).toHaveLength(2);
  });

  test("Full rescan refuses a sync that starts while token mint is awaited", async () => {
    const transpiler = new Bun.Transpiler({ loader: "ts" });
    const executable = transpiler.transformSync(gmeetEngine);
    const buildRunGmeetSyncNow = new Function(
      "mintGmeetAccessToken",
      "GmeetClient",
      "syncGoogleMeet",
      "GMEET_STORE",
      "isGmeetSyncInFlight",
      "gmeetRowProgress",
      `${executable}\nreturn runGmeetSyncNow;`,
    ) as (...dependencies: unknown[]) => (opts: Record<string, unknown>) => Promise<{
      ok: boolean;
      message?: string;
      retryAfterMs?: number | null;
    }>;
    let inFlight = false;
    let engineInvocations = 0;
    const runGmeetSyncNow = buildRunGmeetSyncNow(
      async () => {
        await Promise.resolve();
        inFlight = true;
        return "access-token";
      },
      class {},
      async () => {
        engineInvocations++;
        return { ok: true, data: {} };
      },
      {},
      () => inFlight,
      (progress: unknown) => progress,
    );

    const result = await runGmeetSyncNow({
      tcw: {},
      backendUrl: "http://localhost",
      sessionStore: {},
      refreshToken: "refresh-token",
      driveMode: "snapshot",
      signal: new AbortController().signal,
      onProgress: () => {},
    });

    expect(result).toEqual({
      ok: false,
      message: "Another Google Meet sync is already running. Try Full rescan again when it finishes.",
      retryAfterMs: null,
    });
    expect(engineInvocations).toBe(0);
  });

  test("a successful Meet-only sync still surfaces the persisted reconnect-required partial state", () => {
    // A legacy grant can continue its Meet pass while Drive rejects the new
    // scope. That is neither a full failure nor a success the card may hide.
    expect(card).toContain('state.connection?.lastSyncStatus === "partial"');
    expect(card).toContain("state.connection.lastSyncError");
  });

  test("nothing in the card logs or persists token material", () => {
    expect(card).not.toMatch(/console\.(log|debug|info|warn|error)\(/);
    expect(card).not.toContain("localStorage");
    expect(card).not.toContain("sessionStorage");
  });
});
