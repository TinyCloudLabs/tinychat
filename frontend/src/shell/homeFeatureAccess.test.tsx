import { afterEach, beforeEach, expect, test } from "bun:test";
import { act, useCallback, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { installDom } from "@/test/dom";
import type { InFlightWork } from "@/lib/inFlightWork";
import {
  HomeFeatureAccessContext,
  HomeFeatureGate,
  useHomeFeatureAccessState,
  type FeatureAccessOutcome,
  type HomeFeatureAccess,
} from "./homeFeatureAccess";
import { FEATURE_ACCESS_BODY, FEATURE_ACCESS_WRONG_ACCOUNT } from "@/lib/homeStrings";

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
let latestAccess: HomeFeatureAccess | null = null;
function Harness(props: {
  initial: TinyCloudWeb;
  /** Answers the ask; the returned session (if any) replaces the current one, as the page's re-authorise does. */
  answer: () => Promise<{ outcome: FeatureAccessOutcome; next?: TinyCloudWeb }>;
  inFlight?: InFlightWork;
  enabled?: boolean;
  store?: Pick<Storage, "getItem" | "setItem">;
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
    enabled: props.enabled ?? true, tcw, address: ADDRESS, store: props.store ?? storage(), requestFeatureAccess, inFlight: props.inFlight ?? null,
  });
  latestAccess = access;
  return <HomeFeatureAccessContext.Provider value={access}>{props.children}</HomeFeatureAccessContext.Provider>;
}

let asked: string[] = [];
const mountedConnectors: number[] = [];
function ConnectorsScreen() {
  mountedConnectors.push(1);
  return <div data-testid="connectors-screen" />;
}
function page(props: Omit<Parameters<typeof Harness>[0], "children">) {
  return (
    <Harness {...props}>
      <div data-testid="feed">feed</div>
      <HomeFeatureGate feature="connectors"><ConnectorsScreen /></HomeFeatureGate>
    </Harness>
  );
}
const button = (label: string) => [...host.querySelectorAll("button")].find((entry) => entry.textContent === label) as HTMLButtonElement | undefined;
async function click(label: string) {
  await act(async () => { button(label)!.click(); await Promise.resolve(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}
beforeEach(() => { asked = []; mountedConnectors.length = 0; currentTcw = null; latestAccess = null; });

test("opening Connectors without its set shows the prompt and calls nothing that needs the set", async () => {
  const base = session(false);
  await act(async () => root.render(page({ initial: asTcw(base), answer: async () => ({ outcome: "declined" }) })));
  expect(host.querySelector("h2")?.textContent).toBe("Allow Connectors");
  expect(host.textContent).toContain(FEATURE_ACCESS_BODY.connectors);
  expect(button("Continue")?.disabled).toBe(false);
  expect(button("Not now")).toBeTruthy();
  expect(mountedConnectors).toEqual([]);
  expect(base.reads).toBe(0);
  expect(asked).toEqual([]);
  expect(store.size).toBe(0);
});

test("Continue asks once for Connectors; the new session opens it, and the flag follows the first successful call, not the approval", async () => {
  const firstRead = Promise.withResolvers<KvResult>();
  const release = firstRead.resolve;
  const granted = session(true, () => firstRead.promise);
  await act(async () => root.render(page({ initial: asTcw(session(false)), answer: async () => ({ outcome: "granted", next: asTcw(granted) }) })));
  await click("Continue");
  expect(asked).toEqual(["connectors"]);
  expect(host.querySelector('[data-testid="connectors-screen"]')).toBeTruthy();
  expect(host.querySelector('[data-testid="feature-access-connectors"]')).toBeNull();
  // Approved, but nothing has used the rights yet.
  expect(granted.reads).toBe(1);
  expect(store.get(FLAG_KEY)).toBeUndefined();
  await act(async () => { release({ ok: false, error: { code: "KV_NOT_FOUND", message: "none" } }); await Promise.resolve(); });
  expect(JSON.parse(store.get(FLAG_KEY)!)).toEqual(["connectors"]);
});

test("a flag the store refuses is not retried on every render: one read per opening of the feature", async () => {
  const granted = session(true);
  const refusing = { getItem: () => null, setItem: () => { throw new Error("quota"); } };
  const view = (gate: boolean) => (
    <Harness initial={asTcw(granted)} answer={async () => ({ outcome: "declined" })} store={refusing}>
      {gate && <HomeFeatureGate feature="connectors"><ConnectorsScreen /></HomeFeatureGate>}
    </Harness>
  );
  await act(async () => root.render(view(true)));
  for (let render = 0; render < 5; render += 1) {
    await act(async () => { root.render(view(true)); await Promise.resolve(); });
  }
  expect(granted.reads).toBe(1);
  // The owner opens Connectors again later: one more try.
  await act(async () => root.render(view(false)));
  await act(async () => { root.render(view(true)); await Promise.resolve(); });
  expect(granted.reads).toBe(2);
});

test("a first call the session is refused leaves the flag unset", async () => {
  const granted = session(true, async () => ({ ok: false, error: { code: "KV_UNAUTHORIZED", message: "no" } }));
  await act(async () => root.render(page({ initial: asTcw(session(false)), answer: async () => ({ outcome: "granted", next: asTcw(granted) }) })));
  await click("Continue");
  expect(host.querySelector('[data-testid="connectors-screen"]')).toBeTruthy();
  expect(store.get(FLAG_KEY)).toBeUndefined();
});

test("declining keeps the session and the feed, sets no flag, and says so plainly with a retry", async () => {
  const base = asTcw(session(false));
  await act(async () => root.render(page({ initial: base, answer: async () => ({ outcome: "declined" }) })));
  await click("Continue");
  expect(asked).toEqual(["connectors"]);
  expect(currentTcw).toBe(base);
  expect(host.querySelector('[data-testid="feed"]')?.textContent).toBe("feed");
  expect(host.querySelector('[role="alert"]')?.textContent).toBe("Permission wasn't given. Nothing changed.");
  expect(mountedConnectors).toEqual([]);
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

test("every outcome leaves the prompt usable, with plain words and both buttons", async () => {
  const cases = [
    ["declined", "Permission wasn't given. Nothing changed."],
    ["failed", "Couldn't ask for permission. Nothing changed. Try again."],
    ["wrong-account", FEATURE_ACCESS_WRONG_ACCOUNT],
    ["busy", "Finish the current recording or upload first."],
    // Granted, but the session still lacks the set (it was not swapped in): back to the ask.
    ["granted", null],
    ["signed-out", null],
  ] as const;
  for (const [outcome, alert] of cases) {
    await act(async () => root.render(<div key={outcome}>{page({ initial: asTcw(session(false)), answer: async () => ({ outcome }) })}</div>));
    await click("Continue");
    expect(host.querySelector('[role="alert"]')?.textContent ?? null).toBe(alert);
    expect(button("Continue")?.disabled).toBe(false);
    expect(button("Not now")).toBeTruthy();
    expect(store.size).toBe(0);
  }
});

test("Not now leaves the prompt, calmly, with Continue to ask later", async () => {
  await act(async () => root.render(page({ initial: asTcw(session(false)), answer: async () => ({ outcome: "declined" }) })));
  await click("Not now");
  expect(host.textContent).toContain("Connectors need your permission.");
  expect(button("Not now")).toBeUndefined();
  expect(button("Continue")?.disabled).toBe(false);
  expect(asked).toEqual([]);
  expect(host.querySelector('[data-testid="feed"]')).toBeTruthy();
});

test("Continue waits while a recording or an upload is running, with Not now still there, and comes back when it ends", async () => {
  const props = { initial: asTcw(session(false)), answer: async () => ({ outcome: "declined" as const }) };
  for (const inFlight of ["recording", "upload"] as const) {
    await act(async () => root.render(page({ ...props, inFlight })));
    expect(button("Continue")?.disabled).toBe(true);
    expect(button("Not now")?.disabled).toBe(false);
    expect(host.textContent).toContain("Finish the current recording or upload first.");
  }
  await act(async () => root.render(page({ ...props, inFlight: null })));
  expect(button("Continue")?.disabled).toBe(false);
  expect(host.textContent).not.toContain("Finish the current recording or upload first.");
});

test("a session that already covers Connectors opens it without asking", async () => {
  await act(async () => root.render(page({ initial: asTcw(session(true)), answer: async () => ({ outcome: "declined" }) })));
  expect(host.querySelector('[data-testid="connectors-screen"]')).toBeTruthy();
  expect(host.querySelector('[data-testid="feature-access-connectors"]')).toBeNull();
});

test("when not enabled (phone, desktop) everything is covered and nothing is asked", async () => {
  const off = session(false);
  await act(async () => root.render(page({ enabled: false, initial: asTcw(off), answer: async () => ({ outcome: "declined" }) })));
  expect(host.querySelector('[data-testid="connectors-screen"]')).toBeTruthy();
  expect(host.querySelector('[data-testid="feature-access-connectors"]')).toBeNull();
  expect(latestAccess!.covered("connectors")).toBe(true);
  latestAccess!.confirmUse("connectors");
  await act(async () => { await Promise.resolve(); });
  expect(asked).toEqual([]);
  expect(off.reads).toBe(0);
  expect(store.size).toBe(0);
});

test("Continue clicked twice while the ask is pending asks once; once granted the screen opens with no further ask", async () => {
  const answer = Promise.withResolvers<{ outcome: FeatureAccessOutcome; next?: TinyCloudWeb }>();
  await act(async () => root.render(page({ initial: asTcw(session(false)), answer: () => answer.promise })));
  await click("Continue");
  expect(button("Continue")?.disabled).toBe(true);
  await click("Continue");
  expect(asked).toEqual(["connectors"]);
  await act(async () => { answer.resolve({ outcome: "granted", next: asTcw(session(true)) }); await Promise.resolve(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  expect(host.querySelector('[data-testid="connectors-screen"]')).toBeTruthy();
  expect(host.querySelector('[data-testid="feature-access-connectors"]')).toBeNull();
  expect(asked).toEqual(["connectors"]);
});
