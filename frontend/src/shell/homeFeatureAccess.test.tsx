import { afterEach, beforeEach, expect, test } from "bun:test";
import { act, useCallback, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import type { SessionStore } from "@tinyboilerplate/client";
import { MeetingsSection } from "@/chat/MeetingsSection";
import type { ConnectorMeetingsClient } from "@/lib/connectors/meetingsApi";
import { installDom } from "@/test/dom";
import type { InFlightWork } from "@/lib/inFlightWork";
import {
  HomeFeatureAccessContext,
  HomeFeatureGate,
  useHomeFeatureAccess,
  useHomeFeatureAccessState,
  type FeatureAccessOutcome,
} from "./homeFeatureAccess";
import { FEATURE_ACCESS_BODY } from "@/lib/homeStrings";

const ADDRESS = "0x00000000000000000000000000000000000000a1";
const FLAG_KEY = `xyz.tinycloud.tinychat:home-features:${ADDRESS}`;

type KvResult = { ok: true; data: unknown } | { ok: false; error: { code: string; message: string } };
interface FakeSession { covers: boolean; reads: number; read: () => Promise<KvResult> }
function session(covers: boolean, read: () => Promise<KvResult> = async () => ({ ok: false, error: { code: "KV_NOT_FOUND", message: "none" } })): FakeSession {
  return { covers, reads: 0, read };
}
function asTcw(fake: FakeSession): TinyCloudWeb {
  return {
    hasPermissions: () => fake.covers,
    kv: { get: () => { fake.reads += 1; return fake.read(); } },
  } as unknown as TinyCloudWeb;
}

let restoreDom: () => void;
let host: HTMLDivElement;
let root: Root;
let store: Map<string, string>;
const storage = () => ({ getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value); } });
beforeEach(() => {
  restoreDom = installDom();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  store = new Map();
});
afterEach(async () => {
  await act(async () => root.unmount());
  restoreDom();
});

let currentTcw: TinyCloudWeb | null = null;
let permitted: boolean | null = null;
function Permitted() {
  permitted = useHomeFeatureAccess().permitted("recording");
  return null;
}
function Harness(props: {
  initial: TinyCloudWeb;
  /** Answers the ask; the returned session (if any) replaces the current one, as the page's re-authorise does. */
  answer: () => Promise<{ outcome: FeatureAccessOutcome; next?: TinyCloudWeb }>;
  inFlight?: InFlightWork;
  homeSite?: boolean;
  children: ReactNode;
}) {
  const [tcw, setTcw] = useState(props.initial);
  currentTcw = tcw;
  const { answer } = props;
  const requestFeatureAccess = useCallback(async (feature: string) => {
    asked.push(feature);
    const { outcome, next } = await answer();
    if (outcome === "granted" && next) setTcw(next);
    return outcome;
  }, [answer]);
  const access = useHomeFeatureAccessState({
    homeSite: props.homeSite ?? true, tcw, address: ADDRESS, store: storage(), requestFeatureAccess, inFlight: props.inFlight ?? null,
  });
  return <HomeFeatureAccessContext.Provider value={access}><Permitted />{props.children}</HomeFeatureAccessContext.Provider>;
}

let asked: string[] = [];
const mountedRecording: number[] = [];
function RecordingScreen() {
  mountedRecording.push(1);
  return <div data-testid="recording-screen" />;
}
function page(props: Omit<Parameters<typeof Harness>[0], "children">) {
  return (
    <Harness {...props}>
      <div data-testid="feed">feed</div>
      <HomeFeatureGate feature="recording"><RecordingScreen /></HomeFeatureGate>
    </Harness>
  );
}
const button = (label: string) => [...host.querySelectorAll("button")].find((entry) => entry.textContent === label) as HTMLButtonElement | undefined;
async function click(label: string) {
  await act(async () => { button(label)!.click(); await Promise.resolve(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}
beforeEach(() => { asked = []; mountedRecording.length = 0; currentTcw = null; permitted = null; });

test("opening Recording without its set shows the prompt and calls nothing that needs the set", async () => {
  const base = session(false);
  await act(async () => root.render(page({ initial: asTcw(base), answer: async () => ({ outcome: "declined" }) })));
  expect(host.querySelector("h2")?.textContent).toBe("Allow Recording");
  expect(host.textContent).toContain(FEATURE_ACCESS_BODY.recording);
  expect(button("Continue")?.disabled).toBe(false);
  expect(button("Not now")).toBeTruthy();
  expect(mountedRecording).toEqual([]);
  expect(base.reads).toBe(0);
  expect(asked).toEqual([]);
  expect(store.size).toBe(0);
});

test("Continue asks once for Recording; the new session opens it, and the flag follows the first successful call, not the approval", async () => {
  const firstRead = Promise.withResolvers<KvResult>();
  const release = firstRead.resolve;
  const granted = session(true, () => firstRead.promise);
  await act(async () => root.render(page({ initial: asTcw(session(false)), answer: async () => ({ outcome: "granted", next: asTcw(granted) }) })));
  await click("Continue");
  expect(asked).toEqual(["recording"]);
  expect(host.querySelector('[data-testid="recording-screen"]')).toBeTruthy();
  expect(host.querySelector('[data-testid="feature-access-recording"]')).toBeNull();
  // Approved, but nothing has used the rights yet.
  expect(granted.reads).toBe(1);
  expect(store.get(FLAG_KEY)).toBeUndefined();
  expect(permitted).toBe(false);
  await act(async () => { release({ ok: false, error: { code: "KV_NOT_FOUND", message: "none" } }); await Promise.resolve(); });
  expect(JSON.parse(store.get(FLAG_KEY)!)).toEqual(["recording"]);
  expect(permitted).toBe(true);
});

test("a first call the session is refused leaves the flag unset", async () => {
  const granted = session(true, async () => ({ ok: false, error: { code: "KV_UNAUTHORIZED", message: "no" } }));
  await act(async () => root.render(page({ initial: asTcw(session(false)), answer: async () => ({ outcome: "granted", next: asTcw(granted) }) })));
  await click("Continue");
  expect(host.querySelector('[data-testid="recording-screen"]')).toBeTruthy();
  expect(store.get(FLAG_KEY)).toBeUndefined();
  expect(permitted).toBe(false);
});

test("declining keeps the session and the feed, sets no flag, and says so plainly with a retry", async () => {
  const base = asTcw(session(false));
  await act(async () => root.render(page({ initial: base, answer: async () => ({ outcome: "declined" }) })));
  await click("Continue");
  expect(asked).toEqual(["recording"]);
  expect(currentTcw).toBe(base);
  expect(host.querySelector('[data-testid="feed"]')?.textContent).toBe("feed");
  expect(host.querySelector('[role="alert"]')?.textContent).toBe("Permission wasn't given. Nothing changed.");
  expect(mountedRecording).toEqual([]);
  expect(store.size).toBe(0);
  expect(button("Continue")?.disabled).toBe(false);
});

test("a failed ask shows plain words, never the cause", async () => {
  await act(async () => root.render(page({ initial: asTcw(session(false)), answer: async () => { throw new Error("internal cause"); } })));
  await click("Continue");
  expect(host.querySelector('[role="alert"]')?.textContent).toBe("Couldn't ask for permission. Nothing changed. Try again.");
  expect(host.textContent).not.toContain("internal cause");
  expect(store.size).toBe(0);
});

test("Not now leaves the prompt, calmly, with Continue to ask later", async () => {
  await act(async () => root.render(page({ initial: asTcw(session(false)), answer: async () => ({ outcome: "declined" }) })));
  await click("Not now");
  expect(host.textContent).toContain("Recording needs your permission.");
  expect(button("Not now")).toBeUndefined();
  expect(button("Continue")?.disabled).toBe(false);
  expect(asked).toEqual([]);
  expect(host.querySelector('[data-testid="feed"]')).toBeTruthy();
});

test("Continue waits while a recording or an upload is running, and comes back when it ends", async () => {
  const props = { initial: asTcw(session(false)), answer: async () => ({ outcome: "declined" as const }) };
  for (const inFlight of ["recording", "upload"] as const) {
    await act(async () => root.render(page({ ...props, inFlight })));
    expect(button("Continue")?.disabled).toBe(true);
    expect(host.textContent).toContain("Finish the current recording or upload first.");
  }
  await act(async () => root.render(page({ ...props, inFlight: null })));
  expect(button("Continue")?.disabled).toBe(false);
  expect(host.textContent).not.toContain("Finish the current recording or upload first.");
});

test("a session that already covers Recording opens it without asking", async () => {
  await act(async () => root.render(page({ initial: asTcw(session(true)), answer: async () => ({ outcome: "declined" }) })));
  expect(host.querySelector('[data-testid="recording-screen"]')).toBeTruthy();
  expect(host.querySelector('[data-testid="feature-access-recording"]')).toBeNull();
});

test("off the Home site the gate shows the feature and asks nothing", async () => {
  await act(async () => root.render(page({ homeSite: false, initial: asTcw(session(false)), answer: async () => ({ outcome: "declined" }) })));
  expect(host.querySelector('[data-testid="recording-screen"]')).toBeTruthy();
  expect(host.querySelector('[data-testid="feature-access-recording"]')).toBeNull();
  expect(permitted).toBe(true);
  expect(store.size).toBe(0);
});

test("the meetings list asks the meetings route on the Home site only once Connectors is permitted", async () => {
  let listed = 0;
  const client = { list: async () => { listed += 1; return { ok: false, kind: "feature-dark" }; } } as unknown as ConnectorMeetingsClient;
  const sessionStore = {} as SessionStore;
  const meetings = (connectorsPermitted: boolean) => (
    <HomeFeatureAccessContext.Provider value={{ covered: () => true, permitted: (feature) => feature === "connectors" && connectorsPermitted, request: async () => "failed", confirmUse: () => {}, inFlight: null }}>
      <MeetingsSection backendUrl="http://localhost" sessionStore={sessionStore} client={client} />
    </HomeFeatureAccessContext.Provider>
  );
  await act(async () => root.render(meetings(false)));
  expect(listed).toBe(0);
  await act(async () => root.render(meetings(true)));
  expect(listed).toBe(1);
});
