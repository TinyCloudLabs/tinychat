import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

import type { GmeetLiveStatus, GmeetSyncProgress } from "@/lib/connectors/gmeetSync";
import {
  CopyGmeetSyncLogButton,
  GmeetBusyOffer,
  GmeetLiveLine,
  describeGmeetLive,
} from "./GmeetCardStatus";

const progress = (patch: Partial<GmeetSyncProgress>): GmeetSyncProgress => ({
  type: "progress", current: 18, total: 18, synced: 0, failed: 0, skipped: 0, ...patch,
});
const live = (patch: Partial<GmeetLiveStatus> = {}): GmeetLiveStatus => ({ running: true, progress: null, resumed: false, ...patch });

describe("describeGmeetLive", () => {
  test("says nothing while nothing runs", () => {
    expect(describeGmeetLive(live({ running: false }))).toBeNull();
  });

  test("shows Notes done/total during the background reconcile", () => {
    expect(describeGmeetLive(live({ progress: progress({ stage: "notes", notesDone: 11, notesTotal: 26 }) })))
      .toBe("Google Meet is syncing · Notes 11/26");
  });

  test("shows the Meet records checked while the foreground part runs", () => {
    expect(describeGmeetLive(live({ progress: progress({ stage: "meetings", current: 5, total: 18 }) })))
      .toBe("Google Meet is syncing · Meet records 5/18");
  });

  test("says so when the Notes sync continues one an earlier page load left", () => {
    expect(describeGmeetLive(live({ resumed: true, progress: progress({ stage: "notes", notesDone: 10, notesTotal: 26 }) })))
      .toBe("Resuming a Notes sync that an earlier page load left unfinished · Notes 10/26");
  });
});

describe("Google Meet row extras", () => {
  test("the live line renders only while a sync runs", () => {
    expect(renderToStaticMarkup(<GmeetLiveLine status={live({ running: false })} />)).toBe("");
    const html = renderToStaticMarkup(<GmeetLiveLine status={live({ progress: progress({ stage: "notes", notesDone: 3, notesTotal: 9 }) })} />);
    expect(html).toContain("Notes 3/9");
  });

  test("a refused Full rescan shows the running sync's progress and offers to wait", () => {
    const html = renderToStaticMarkup(
      <GmeetBusyOffer mode="snapshot" status={live({ progress: progress({ stage: "notes", notesDone: 11, notesTotal: 26 }) })}
        queued={false} onWait={() => {}} onCancel={() => {}} />,
    );
    expect(html).toContain("Another Google Meet sync is running");
    expect(html).toContain("Notes 11/26");
    expect(html).toContain("Wait, then run Full rescan");
    expect(html).not.toContain("Cancel");
  });

  test("an accepted offer says what will start and can be cancelled", () => {
    const html = renderToStaticMarkup(
      <GmeetBusyOffer mode="auto" status={live()} queued onWait={() => {}} onCancel={() => {}} />,
    );
    expect(html).toContain("Sync now will start when it finishes.");
    expect(html).toContain("Cancel");
    expect(html).not.toContain("Wait, then run");
  });

  test("Copy sync log is a button on the card", () => {
    expect(renderToStaticMarkup(<CopyGmeetSyncLogButton getLog={() => null} />)).toContain("Copy sync log");
  });
});

describe("card wiring", () => {
  // ConnectorsCard.tsx cannot be imported into a bun process (see ConnectorsCard.test.ts).
  const card = readFileSync(join(import.meta.dir, "ConnectorsCard.tsx"), "utf8");

  test("the card subscribes to the engine's live status and shows it for the Google Meet row only", () => {
    expect(card).toContain("useSyncExternalStore(onGmeetLiveStatus, () => getGmeetLiveStatus(tcw)");
    expect(card).toContain("gmeet={d.id === GMEET_CONNECTOR_ID ?");
    expect(card).toContain("<GmeetLiveLine status={gmeet.live} />");
  });

  test("an accepted offer starts the refused press once nothing is running", () => {
    const effect = card.slice(card.indexOf("const gmeetQueued"), card.indexOf("const handleDisconnect"));
    expect(effect).toContain("if (gmeetQueued === null || live.running) return;");
    expect(effect).toContain("handleSyncNow(descriptor, gmeetQueued)");
  });

  test("the card copies the account's last log, in memory or persisted", () => {
    expect(card).toContain("loadGmeetSyncLog(tcw, buildLabel)");
    expect(card).toContain("<CopyGmeetSyncLogButton getLog={gmeet.getLog} />");
  });
});
