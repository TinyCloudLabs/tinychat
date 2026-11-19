// The Meet row's engine-derived state follows the account that is mounted: a checkpoint, a count or a
// log written for one account is never shown for another (TC-1376).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

import * as connectorStore from "@/lib/connectors/connectorStore";
import { publishGmeetMeetingCount, resetGmeetMeetingCountsForTests } from "@/lib/connectors/gmeetLiveCount";
import { _resetGmeetSyncSingleFlightForTests } from "@/lib/connectors/gmeetSync";
import { installDom } from "@/test/dom";
import { makeFakeTinyCloud } from "../../../test/connectors/fake-tinycloud";
import { useGmeetRowStatus, type GmeetRowStatus } from "./useGmeetRowStatus";

let uninstall: () => void;
beforeEach(() => {
  uninstall = installDom();
  connectorStore._resetConnectorSchemaMemoForTests();
  _resetGmeetSyncSingleFlightForTests();
  resetGmeetMeetingCountsForTests();
});
afterEach(() => uninstall());

describe("useGmeetRowStatus", () => {
  test("an interrupted Notes sync and the live count are read for the mounted account only", async () => {
    const alice = makeFakeTinyCloud({ did: "did:example:alice" });
    const bob = makeFakeTinyCloud({ did: "did:example:bob" });
    const doneIds = ["n0", "n1", "n2", "n3", "n4", "n5", "n6", "n7", "n8", "n9", "n10"];
    const written = await connectorStore.putDriveProgress(alice.tcw, "google-meet", {
      startToken: "t", doneIds, savedAt: new Date().toISOString(), total: 26,
    });
    expect(written.ok).toBe(true);

    let status!: GmeetRowStatus;
    function Probe({ tcw }: { tcw: TinyCloudWeb }) {
      status = useGmeetRowStatus(tcw, { connected: true });
      return null;
    }
    const root = createRoot(document.body.appendChild(document.createElement("div")));
    const render = (tcw: TinyCloudWeb) => act(async () => { root.render(createElement(Probe, { tcw })); });
    const settle = () => act(async () => { for (let i = 0; i < 200; i++) await Promise.resolve(); });

    await render(alice.tcw);
    await settle();
    expect(status.interrupted).toBe("A Notes sync was interrupted at 11/26. Sync now resumes it.");

    publishGmeetMeetingCount(alice.tcw, 11);
    await settle();
    expect(status.count).toBe(11);

    // Switching account: nothing of Alice's is shown for Bob, not even for the render before Bob's read lands.
    await render(bob.tcw as unknown as TinyCloudWeb);
    expect(status.interrupted).toBeNull();
    expect(status.count).not.toBe(11);
    await settle();
    expect(status.interrupted).toBeNull();
    expect(status.count).toBe(0); // Bob's own rows.

    await render(alice.tcw);
    await settle();
    expect(status.interrupted).toBe("A Notes sync was interrupted at 11/26. Sync now resumes it.");
    await act(async () => { root.unmount(); });
  });
});
