import { describe, expect, test } from "bun:test";
import { ONE_APPS, ONE_HOST_ORIGINS, appTarget, framedApp, framesAppsHere, frameUrl, oneApp, oneAppsFor, type FramedOneApp } from "./registry";
import { joinScopes } from "./strings";

const framed = (apps: readonly { kind: string }[]) => apps.filter((app): app is FramedOneApp => app.kind === "framed");

describe("registry", () => {
  test("every framed origin is an exact https origin from the production list (bun test runs as production)", () => {
    for (const app of framed(ONE_APPS)) {
      const url = new URL(app.origin);
      expect(url.protocol).toBe("https:");
      expect(url.origin).toBe(app.origin);
    }
    expect(framed(ONE_APPS).map((app) => app.origin)).toEqual([
      "https://secrets.tinycloud.xyz",
      "https://credentials.org",
      "https://explorer.tinycloud.xyz",
      "https://account.tinycloud.xyz",
      "https://share.tinycloud.xyz",
      "https://rocinante-ledger.pages.dev",
    ]);
    expect(ONE_HOST_ORIGINS).toEqual(["https://tinycloud.one"]);
  });

  test("frames only on One's exact production origin", () => {
    expect(framesAppsHere("https://tinycloud.one")).toBe(true);
    for (const origin of ["https://home.tinycloud.xyz", "https://tinycloud.chat", "https://tinycloud.one.evil.example", "http://tinycloud.one", "https://localhost:5186", "https://localhost:5190", "https://feat-one-apps.tinychat.pages.dev"]) {
      expect(framesAppsHere(origin)).toBe(false);
    }
  });

  test("the frame URL stays on the app's origin and asks for embedded mode", () => {
    for (const app of framed(ONE_APPS)) {
      const url = new URL(frameUrl(app));
      expect(url.origin).toBe(app.origin);
      expect(url.searchParams.get("embed")).toBe("one");
    }
  });

  test("the registry cannot be changed at runtime", () => {
    expect(Object.isFrozen(ONE_APPS)).toBe(true);
  });

  test("tiles: framed apps route inside One only on One's origin; Secrets always opens a new tab", () => {
    const explorer = oneApp("xyz.tinycloud.explorer")!;
    const secrets = oneApp("xyz.tinycloud.secrets")!;
    expect(appTarget(explorer, "https://tinycloud.one")).toEqual({ kind: "route", path: "/chat/apps/xyz.tinycloud.explorer" });
    expect(appTarget(explorer, "https://home.tinycloud.xyz")).toEqual({ kind: "newTab", url: "https://explorer.tinycloud.xyz/" });
    expect(appTarget(secrets, "https://tinycloud.one")).toEqual({ kind: "newTab", url: "https://secrets.tinycloud.xyz/app" });
    expect(appTarget(oneApp("capture")!, "https://home.tinycloud.xyz")).toEqual({ kind: "route", path: "/chat/capture" });
    expect(framedApp("xyz.tinycloud.secrets")).toBeUndefined();
    expect(framedApp("capture")).toBeUndefined();
    expect(framedApp("xyz.tinycloud.explorer")?.id).toBe("xyz.tinycloud.explorer");
    // Credentials opens in a new tab; Courier is framed inside One.
    expect(appTarget(oneApp("xyz.tinycloud.opencredentials")!, "https://tinycloud.one")).toEqual({ kind: "newTab", url: "https://credentials.org/" });
    expect(appTarget(oneApp("xyz.tinycloud.courier")!, "https://tinycloud.one")).toEqual({ kind: "route", path: "/chat/apps/xyz.tinycloud.courier" });
    expect(framedApp("xyz.tinycloud.opencredentials")).toBeUndefined();
    expect(framedApp("xyz.tinycloud.courier")?.id).toBe("xyz.tinycloud.courier");
  });

  test("iOS leaves Account out; web and Android keep it", () => {
    expect(oneAppsFor("ios").some((app) => app.id === "xyz.tinycloud.account")).toBe(false);
    expect(oneAppsFor("ios").map((app) => app.id)).toEqual(["capture", "xyz.tinycloud.secrets", "xyz.tinycloud.opencredentials", "xyz.tinycloud.explorer", "xyz.tinycloud.courier", "xyz.tinycloud.rocinante.ledger"]);
    expect(oneAppsFor("web").some((app) => app.id === "xyz.tinycloud.account")).toBe(true);
    expect(oneAppsFor("android").some((app) => app.id === "xyz.tinycloud.account")).toBe(true);
  });

  test("Courier is framed from exactly https://share.tinycloud.xyz/courier, read-only, and no other share page is framed", () => {
    // Courier is framed inside One; its entry's origin, path and access are what this checks.
    const courier = oneApp("xyz.tinycloud.courier");
    if (courier?.kind !== "framed") throw new Error("Courier is a TinyCloud web app");
    expect(courier.origin).toBe("https://share.tinycloud.xyz");
    expect(new URL(frameUrl(courier)).pathname).toBe("/courier");
    expect(framed(ONE_APPS).filter((app) => new URL(app.origin).hostname === "share.tinycloud.xyz").map((app) => app.id))
      .toEqual(["xyz.tinycloud.courier"]);
    expect(courier.ceiling({ address: "0x1111111111111111111111111111111111111111", chainId: 1 }).map(({ permission }) => permission)).toEqual([
      { service: "tinycloud.kv", space: "agents", path: "xyz.tinycloud.courier/", actions: ["get", "list"], skipPrefix: true },
    ]);
  });

  test("the phone app frames only Explorer and the Ship ledger, only on its exact origins; Account, Courier and the rest open outside", () => {
    const explorer = oneApp("xyz.tinycloud.explorer")!;
    for (const origin of ["capacitor://localhost", "https://localhost"]) {
      expect(appTarget(explorer, origin)).toEqual({ kind: "route", path: "/chat/apps/xyz.tinycloud.explorer" });
      expect(appTarget(oneApp("xyz.tinycloud.rocinante.ledger")!, origin)).toEqual({ kind: "route", path: "/chat/apps/xyz.tinycloud.rocinante.ledger" });
      for (const id of ["xyz.tinycloud.account", "xyz.tinycloud.courier", "xyz.tinycloud.secrets", "xyz.tinycloud.opencredentials"] as const) {
        expect(appTarget(oneApp(id)!, origin).kind).toBe("newTab");
      }
    }
    // A page elsewhere on a localhost-like origin is not the phone app.
    for (const origin of ["http://localhost", "https://localhost:8443", "https://evil.localhost", "capacitor://localhost:1", "capacitor://evil", "https://localhost.evil.example"]) {
      expect(appTarget(explorer, origin)).toEqual({ kind: "newTab", url: "https://explorer.tinycloud.xyz/" });
    }
  });
});

describe("joinScopes", () => {
  test("no serial comma", () => {
    expect(joinScopes(["secrets"])).toBe("your secrets");
    expect(joinScopes(["secrets", "variables"])).toBe("your secrets and your environment variables");
    expect(joinScopes(["installedApps", "spaces", "publicSpace"])).toBe(
      "your installed apps, the list of your spaces and your public space",
    );
  });

  test("the secret-names phrase always goes last, and repeats collapse", () => {
    expect(joinScopes(["secretNames", "appsData", "publicSpace", "appsData"])).toBe(
      "the data your apps keep in TinyCloud, your public space and the names of your secrets and variables, not their values",
    );
  });

  test("nothing joins to an empty string", () => {
    expect(joinScopes([])).toBe("");
  });
});
