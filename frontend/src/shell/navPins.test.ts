import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AppWindowIcon } from "lucide-react";

import { currentItemId, navItems, navTarget, tabBarItems, TAB_BAR_MAX, type NavApp } from "./navItems";
import { appPinId, navPinsKey, parsePins, pinDestination, unpinDestination, type PinId } from "./navPins";
import { screenFor } from "./routes";

const KNOWN = ["xyz.tinycloud.secrets", "xyz.tinycloud.explorer", "xyz.tinycloud.account"];
const APPS: NavApp[] = KNOWN.map((id) => ({
  id,
  name: id.split(".").pop()!,
  icon: AppWindowIcon,
  target: id === "xyz.tinycloud.secrets"
    ? { kind: "newTab", url: "https://secrets.tinycloud.xyz/app" }
    : { kind: "route", path: `/chat/apps/${id}` },
}));
const ALICE = "did:pkh:eip155:1:0xalice";
const BOB = "did:pkh:eip155:1:0xbob";

const memory = new Map<string, string>();
const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");

beforeEach(() => {
  memory.clear();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => memory.get(key) ?? null,
      setItem: (key: string, value: string) => void memory.set(key, value),
    },
  });
});

afterEach(() => {
  if (original) Object.defineProperty(globalThis, "localStorage", original);
  else delete (globalThis as { localStorage?: unknown }).localStorage;
});

const stored = (did: string) => parsePins(memory.get(navPinsKey(did)) ?? null, KNOWN);

describe("pins, per account", () => {
  test("keep pin order and survive a reload", () => {
    pinDestination(ALICE, "connectors", KNOWN);
    pinDestination(ALICE, appPinId(KNOWN[1]!), KNOWN);
    pinDestination(ALICE, "capture", KNOWN);
    expect(stored(ALICE)).toEqual(["connectors", "app:xyz.tinycloud.explorer", "capture"]);
  });

  test("do not cross accounts", () => {
    pinDestination(ALICE, "capture", KNOWN);
    expect(stored(ALICE)).toEqual(["capture"]);
    expect(stored(BOB)).toEqual([]);
  });

  test("pinning twice is one pin; unpinning removes it and keeps the rest in order", () => {
    pinDestination(ALICE, "capture", KNOWN);
    pinDestination(ALICE, "capture", KNOWN);
    pinDestination(ALICE, "connectors", KNOWN);
    expect(stored(ALICE)).toEqual(["capture", "connectors"]);
    unpinDestination(ALICE, "capture", KNOWN);
    expect(stored(ALICE)).toEqual(["connectors"]);
  });

  test("the defaults cannot be pinned or unpinned", () => {
    pinDestination(ALICE, "capture", KNOWN);
    for (const id of ["feed", "chat", "apps"]) {
      pinDestination(ALICE, id as PinId, KNOWN);
      unpinDestination(ALICE, id as PinId, KNOWN);
    }
    expect(stored(ALICE)).toEqual(["capture"]);
    const ids = navItems(0, { pins: stored(ALICE), apps: APPS }).map((item) => item.id);
    expect(ids.slice(0, 3)).toEqual(["feed", "chat", "apps"]);
  });

  test("unknown ids, other types and duplicates are dropped on read; bad JSON reads as none", () => {
    const raw = JSON.stringify(["capture", "app:com.gone.app", "settings", 7, null, "capture", "app:xyz.tinycloud.secrets", "app:"]);
    expect(parsePins(raw, KNOWN)).toEqual(["capture", "app:xyz.tinycloud.secrets"]);
    expect(parsePins("{not json", KNOWN)).toEqual([]);
    expect(parsePins(JSON.stringify({ capture: true }), KNOWN)).toEqual([]);
    expect(parsePins(null, KNOWN)).toEqual([]);
  });

  test("an app pin is refused unless the app is known", () => {
    pinDestination(ALICE, "app:com.gone.app", KNOWN);
    expect(memory.has(navPinsKey(ALICE))).toBe(false);
  });
});

describe("navigation with pins", () => {
  const ids = (pins: PinId[]) => navItems(0, { pins, apps: APPS }).map((item) => item.id);

  test("defaults only, then each pin after them in pin order", () => {
    expect(ids([])).toEqual(["feed", "chat", "apps"]);
    expect(ids(["connectors", "app:xyz.tinycloud.secrets", "capture"])).toEqual([
      "feed", "chat", "apps", "connectors", "app:xyz.tinycloud.secrets", "capture",
    ]);
  });

  test("a pinned app follows its registry target and a pin whose app is gone shows nothing", () => {
    const items = navItems(0, { pins: ["app:xyz.tinycloud.secrets", "app:xyz.tinycloud.explorer", "app:com.gone.app"], apps: APPS });
    expect(items).toHaveLength(5);
    expect(items[3]!.newTab).toBe("https://secrets.tinycloud.xyz/app");
    expect(items[3]!.href).toBe("https://secrets.tinycloud.xyz/app");
    expect(items[4]!.newTab).toBeUndefined();
    expect(items[4]!.href).toBe("/chat/apps/xyz.tinycloud.explorer");
    expect(navTarget(items[4]!, false)).toBe("/chat/apps/xyz.tinycloud.explorer");
    expect(navTarget(items[2]!, false)).toBe("/chat/apps");
  });

  test("the Connectors badge stays on its nav item when it is pinned", () => {
    const items = navItems(4, { pins: ["connectors"], apps: APPS });
    expect(items.find((item) => item.id === "connectors")!.badge).toBe(4);
  });

  test("the tab bar holds the defaults and the first two pins; the rail keeps them all", () => {
    const items = navItems(0, { pins: ["capture", "connectors", "app:xyz.tinycloud.secrets", "app:xyz.tinycloud.account"], apps: APPS });
    expect(items).toHaveLength(7);
    expect(tabBarItems(items).map((item) => item.id)).toEqual(["feed", "chat", "apps", "capture", "connectors"]);
    expect(TAB_BAR_MAX).toBe(5);
  });

  test("a pinned app is current on its screen; Apps is current on an unpinned app's screen", () => {
    const items = navItems(0, { pins: ["app:xyz.tinycloud.secrets"], apps: APPS });
    const secrets = { ...screenFor("/chat/apps/xyz.tinycloud.secrets"), appId: "xyz.tinycloud.secrets" };
    const explorer = { ...screenFor("/chat/apps/xyz.tinycloud.explorer"), appId: "xyz.tinycloud.explorer" };
    expect(currentItemId("apps", secrets, items)).toBe("app:xyz.tinycloud.secrets");
    expect(currentItemId("apps", explorer, items)).toBe("apps");
    expect(currentItemId("apps", screenFor("/chat/apps"), items)).toBe("apps");
  });
});

describe("flag off", () => {
  test("the navigation is exactly today's five items, in order, each opening where it was left", () => {
    const items = navItems(2);
    expect(items.map((item) => item.id)).toEqual(["feed", "chat", "apps", "capture", "connectors"]);
    expect(items.some((item) => item.fixed)).toBe(false);
    expect(tabBarItems(items)).toEqual(items);
  });
});
