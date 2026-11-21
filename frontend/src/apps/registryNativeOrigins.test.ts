import { describe, expect, test } from "bun:test";
import { appTarget, framesAppHere, oneApp, type FramedOneApp } from "./registry";

// TC-3045: the phone apps run from their own WebView addresses. If the frame list kept only Capacitor's defaults,
// Explorer would silently open unframed in the in-app browser sheet inside the app.
describe("the phone app frames Explorer on its own WebView addresses", () => {
  const explorer = oneApp("xyz.tinycloud.explorer") as FramedOneApp;

  test("the current iOS and Android origins frame it, and a build still on Capacitor's defaults keeps working", () => {
    for (const origin of ["tinycloudone://app.tinycloud.one", "https://app.tinycloud.one", "capacitor://localhost", "https://localhost"]) {
      expect(framesAppHere(explorer, origin)).toBe(true);
      expect(appTarget(explorer, origin)).toEqual({ kind: "route", path: "/chat/apps/xyz.tinycloud.explorer" });
    }
  });

  test("near misses do not", () => {
    for (const origin of ["capacitor://app.tinycloud.one", "tinycloudone://localhost", "https://app.tinycloud.one:8443", "http://app.tinycloud.one", "https://evil.app.tinycloud.one", "https://app.tinycloud.one.evil.example", "tinycloudone://app.tinycloud.one:1"]) {
      expect(framesAppHere(explorer, origin)).toBe(false);
      expect(appTarget(explorer, origin)).toEqual({ kind: "newTab", url: "https://explorer.tinycloud.xyz/" });
    }
  });

  test("only Explorer is framed in the phone app", () => {
    for (const id of ["xyz.tinycloud.account", "xyz.tinycloud.courier", "xyz.tinycloud.secrets", "xyz.tinycloud.opencredentials"] as const) {
      expect(appTarget(oneApp(id)!, "https://app.tinycloud.one").kind).toBe("newTab");
    }
  });
});
