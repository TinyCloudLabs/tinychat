import { afterEach, describe, expect, test } from "bun:test";
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { APPS_FEED_FEATURE_KEY, appsFeedEnabled, setAppsFeedEnabled, useAppsFeedEnabled } from "../lib/appsFeedFeature";
import { installDom } from "../test/dom";
import { AppShellView } from "./AppShell";
import { ExperimentalRoute } from "./ExperimentalRoute";
import { PATHS, screenFor } from "./routes";

let root: Root | null = null;
let restoreDom: (() => void) | null = null;
let host: HTMLElement;
const mounted: string[] = [];

function Probe({ name }: { name: string }) {
  useEffect(() => {
    mounted.push(name);
    return () => { mounted.push(`${name}:unmount`); };
  }, [name]);
  return <div>{name} work</div>;
}

function Screen() {
  const location = useLocation();
  const navigate = useNavigate();
  const enabled = useAppsFeedEnabled();
  return <>
    <p data-testid="path">{location.pathname}</p>
    <button onClick={() => setAppsFeedEnabled(!enabled)}>Toggle Apps and Feed</button>
    <button onClick={() => navigate(PATHS.feed)}>Open Feed</button>
    <AppShellView
      screen={screenFor(location.pathname)} platform="web" pendingMeetings={0}
      chat={<Probe name="chat" />} capture={<div>Capture</div>}
      connectors={<div>Connectors</div>} settings={<div>Settings</div>}
      feed={<Probe name="feed" />} apps={<Probe name="apps" />}
      sizeClass={{ size: "compact", land: false }} captureMounted={false}
    />
  </>;
}

async function open(path: string, enabled = false) {
  restoreDom = installDom();
  if (enabled) setAppsFeedEnabled(true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(<MemoryRouter initialEntries={[path]}>
    <Routes><Route path="/chat/*" element={<ExperimentalRoute><Screen /></ExperimentalRoute>} /></Routes>
  </MemoryRouter>));
}

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  mounted.length = 0;
  restoreDom?.();
  restoreDom = null;
});

describe("Apps and Feed experimental switch", () => {
  test.each([PATHS.feed, `${PATHS.feed}/story`, PATHS.apps, `${PATHS.apps}/tool`])("defaults off and redirects %s before mounting either surface", async (path) => {
    await open(path);
    expect(appsFeedEnabled()).toBe(false);
    expect(host.querySelector('[data-testid="path"]')?.textContent).toBe(PATHS.chat);
    expect(host.querySelector(`a[href="${PATHS.feed}"]`)).toBeNull();
    expect(host.querySelector(`a[href="${PATHS.apps}"]`)).toBeNull();
    expect(mounted).not.toContain("feed");
    expect(mounted).not.toContain("apps");
  });

  test("enabling shows both links and mounts Feed immediately; disabling redirects and stops its work", async () => {
    await open(PATHS.chat);
    const buttons = host.querySelectorAll("button");
    await act(async () => buttons[0]!.click());
    expect(host.querySelector(`a[href="${PATHS.feed}"]`)).not.toBeNull();
    expect(host.querySelector(`a[href="${PATHS.apps}"]`)).not.toBeNull();
    await act(async () => buttons[1]!.click());
    expect(host.querySelector('[data-testid="path"]')?.textContent).toBe(PATHS.feed);
    expect(mounted).toContain("feed");
    await act(async () => host.querySelector("button")!.click());
    expect(host.querySelector('[data-testid="path"]')?.textContent).toBe(PATHS.chat);
    expect(mounted).toContain("feed:unmount");
  });

  test("the local choice survives remounting and is shared across shell subscribers", async () => {
    await open(PATHS.chat);
    await act(async () => host.querySelector("button")!.click());
    expect(window.localStorage.getItem(APPS_FEED_FEATURE_KEY)).toBe("true");
    await act(async () => root!.unmount());
    root = createRoot(host);
    await act(async () => root!.render(<MemoryRouter initialEntries={[PATHS.chat]}>
      <Routes><Route path="/chat/*" element={<ExperimentalRoute><Screen /></ExperimentalRoute>} /></Routes>
    </MemoryRouter>));
    expect(host.querySelector(`a[href="${PATHS.apps}"]`)).not.toBeNull();
  });
});
