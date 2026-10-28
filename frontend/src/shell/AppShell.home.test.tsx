// Home's mounting rules (TC-2040): Chat stays mounted beneath every other surface;
// Feed is the opposite: mounted only while it is the active destination, because its
// polling and abort live in effects.
import { afterEach, describe, expect, test } from "bun:test";
import { act, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";

import type { SizeClassState } from "@/lib/sizeClass";
import { installDom } from "@/test/dom";
import { AppShellView } from "./AppShell";
import { PATHS, screenFor } from "./routes";

const log: string[] = [];
function Probe({ name }: { name: string }) {
  useEffect(() => {
    log.push(`${name}:mount`);
    return () => void log.push(`${name}:unmount`);
  }, [name]);
  return <p data-probe={name}>{name}</p>;
}

const SIZE: SizeClassState = { size: "compact", land: false };

function Shell({ path }: { path: string }) {
  return (
    <AppShellView
      screen={screenFor(path)}
      platform="web"
      pendingMeetings={0}
      experimentalAppsFeedEnabled
      chat={<Probe name="chat" />}
      capture={null}
      connectors={null}
      feed={<Probe name="feed" />}
      apps={<Probe name="apps" />}
      settings={null}
      sizeClass={SIZE}
      captureMounted={false}
    />
  );
}

let controls: { go: (path: string) => void; signOut: () => void } | null = null;
/** The App's relation to the shell: it renders only while signed in. */
function Session({ initial }: { initial: string }) {
  const [path, setPath] = useState(initial);
  const [signedIn, setSignedIn] = useState(true);
  controls = { go: setPath, signOut: () => setSignedIn(false) };
  return <MemoryRouter initialEntries={[path]}>{signedIn ? <Shell path={path} /> : <p>signed out</p>}</MemoryRouter>;
}

let root: Root | null = null;
let restoreDom: (() => void) | null = null;
const has = (name: string) => document.querySelector(`[data-probe="${name}"]`) !== null;

async function open(initial: string) {
  log.length = 0;
  restoreDom = installDom();
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(<Session initial={initial} />));
}

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  controls = null;
  restoreDom?.();
  restoreDom = null;
});

describe("Feed mounts only while active", () => {
  test("Chat entry does not mount Feed", async () => {
    await open(PATHS.chat);
    expect(has("chat")).toBe(true);
    expect(has("feed")).toBe(false);
    expect(log).not.toContain("feed:mount");
  });

  test("entering Feed mounts it; leaving unmounts it, while Chat is never unmounted", async () => {
    await open(PATHS.feed);
    expect(has("feed")).toBe(true);
    expect(has("chat")).toBe(true);
    expect(document.querySelector('[data-surface="chat"]')?.className).toContain("hidden");
    for (const away of [PATHS.chat, PATHS.apps, PATHS.settings, PATHS.connectors]) {
      await act(async () => controls!.go(PATHS.feed));
      await act(async () => controls!.go(away));
      expect(has("feed")).toBe(false);
    }
    expect(log.filter((entry) => entry === "feed:unmount").length).toBeGreaterThanOrEqual(2);
    expect(log).not.toContain("chat:unmount");
    expect(log.filter((entry) => entry === "chat:mount")).toHaveLength(1);
  });

  test("Chat stays mounted (hidden) beneath Apps", async () => {
    await open(PATHS.apps);
    expect(has("apps")).toBe(true);
    expect(has("chat")).toBe(true);
    expect(document.querySelector('[data-surface="chat"]')?.className).toContain("hidden");
    expect(has("feed")).toBe(false);
  });

  test("sign-out unmounts Feed", async () => {
    await open(PATHS.feed);
    expect(has("feed")).toBe(true);
    await act(async () => controls!.signOut());
    expect(has("feed")).toBe(false);
    expect(log).toContain("feed:unmount");
  });
});
