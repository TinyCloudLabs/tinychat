// The Fireflies row says what Connect does, under the Connect button, every time
// that button shows (first connect and after a disconnect alike): the line is not
// state-dependent, so a disconnect that deleted its data reads the same.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { CONNECTORS } from "@/lib/connectors/registry";
import type { ConnectorConnection } from "@/lib/connectors/types";
import { setSecretsAvailableForTests } from "@/lib/openkeyNative";
import { installDom } from "@/test/dom";
import { ConnectorRow } from "./ConnectorsCard";

const LINE = "Connecting imports your meetings from Fireflies.";

type RowProps = ComponentProps<typeof ConnectorRow>;

let restoreDom: (() => void) | undefined;
beforeEach(() => {
  restoreDom = installDom();
  setSecretsAvailableForTests(true);
});
afterEach(() => {
  setSecretsAvailableForTests(null);
  restoreDom?.();
  restoreDom = undefined;
});

const descriptor = (id: string) => CONNECTORS.find((c) => c.id === id)!;

function connection(status: ConnectorConnection["status"], connectorId = "fireflies"): ConnectorConnection {
  return { connectorId, status, lastSyncedAt: null, lastSyncStatus: null, lastSyncError: null, itemCount: 0 } as ConnectorConnection;
}

function render(id: string, loaded: boolean, conn: ConnectorConnection | null): string {
  const state = {
    loaded,
    connection: conn,
    syncing: false,
    joinedBackgroundSync: false,
    progress: null,
    actionError: null,
    actionRetryAfterMs: null,
    busyOffer: null,
    queuedSync: null,
  } as RowProps["state"];
  const noop = () => {};
  return renderToStaticMarkup(
    <ConnectorRow
      descriptor={descriptor(id)}
      state={state}
      onConnect={noop}
      onSyncNow={noop}
      onStopSync={noop}
      onDisconnect={noop}
    />,
  );
}

describe("Fireflies row: the line under Connect", () => {
  test("shows under the Connect button on a first connect", () => {
    const html = render("fireflies", true, null);
    expect(html).toContain(">Connect</button>");
    expect(html).toContain(LINE);
    expect(html.indexOf(LINE)).toBeGreaterThan(html.indexOf(">Connect</button>"));
  });

  test("shows after a disconnect that kept its data", () => {
    const html = render("fireflies", true, connection("disconnected"));
    expect(html).toContain(">Connect</button>");
    expect(html).toContain(LINE);
  });

  test("does not show while connected", () => {
    const html = render("fireflies", true, connection("connected"));
    expect(html).not.toContain(LINE);
  });

  test("does not show before the row has loaded", () => {
    expect(render("fireflies", false, null)).not.toContain(LINE);
  });

  test("does not show on another connector's Connect button", () => {
    const html = render("google-meet", true, null);
    expect(html).toContain("Connect Google Meet");
    expect(html).not.toContain(LINE);
  });
});
