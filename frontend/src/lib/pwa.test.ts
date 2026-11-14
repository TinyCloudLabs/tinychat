import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { serviceWorkerDecision, type ServiceWorkerEnvironment } from "./pwa";

const web: ServiceWorkerEnvironment = {
  hasServiceWorker: true,
  isCapacitorNative: false,
  isTauri: false,
  protocol: "https:",
  hostname: "tinycloud.chat",
  port: "",
  dev: false,
  devEnabled: false,
};

describe("serviceWorkerDecision", () => {
  test("registers on the deployed web app and a local preview", () => {
    expect(serviceWorkerDecision(web)).toBe("register");
    expect(serviceWorkerDecision({ ...web, protocol: "http:", hostname: "localhost", port: "5394" })).toBe("register");
  });

  test("never registers inside Capacitor, by flag or by origin", () => {
    expect(serviceWorkerDecision({ ...web, isCapacitorNative: true })).toBe("skip:capacitor");
    // Live reload: the native shell loads the Vite dev server, flag still set.
    expect(
      serviceWorkerDecision({ ...web, isCapacitorNative: true, protocol: "http:", hostname: "localhost", port: "5186", dev: true, devEnabled: true }),
    ).toBe("skip:capacitor");
    // iOS bundle (WKWebView has no service workers there anyway).
    expect(serviceWorkerDecision({ ...web, protocol: "tinycloudone:", hostname: "app.tinycloud.one", hasServiceWorker: false })).toBe(
      "skip:capacitor",
    );
    // Android bundle: https://app.tinycloud.one, where the WebView WOULD allow a worker.
    expect(serviceWorkerDecision({ ...web, hostname: "app.tinycloud.one" })).toBe("skip:capacitor");
    // The same host with a port is not the app's origin.
    expect(serviceWorkerDecision({ ...web, hostname: "app.tinycloud.one", port: "8443" })).toBe("register");
  });

  test("never registers inside Tauri, by flag or by origin", () => {
    expect(serviceWorkerDecision({ ...web, isTauri: true })).toBe("skip:tauri");
    expect(serviceWorkerDecision({ ...web, protocol: "tauri:", hostname: "localhost" })).toBe("skip:tauri");
    expect(serviceWorkerDecision({ ...web, protocol: "http:", hostname: "tauri.localhost" })).toBe("skip:tauri");
    // `tauri dev` loads the Vite dev server with the Tauri globals present.
    expect(
      serviceWorkerDecision({ ...web, isTauri: true, protocol: "http:", hostname: "localhost", port: "5186", dev: true, devEnabled: true }),
    ).toBe("skip:tauri");
  });

  test("skips vite dev unless VITE_PWA_DEV opts in", () => {
    const dev = { ...web, protocol: "http:", hostname: "localhost", port: "5186", dev: true };
    expect(serviceWorkerDecision(dev)).toBe("skip:dev");
    expect(serviceWorkerDecision({ ...dev, devEnabled: true })).toBe("register");
  });

  test("skips browsers without service workers", () => {
    expect(serviceWorkerDecision({ ...web, hasServiceWorker: false })).toBe("skip:unsupported");
  });
});

describe("PWA build config", () => {
  const config = readFileSync(path.join(import.meta.dir, "../../vite.config.ts"), "utf8");

  test("the worker caches only same-origin content-hashed chunks at runtime (notes WASM, replication chunks): API and cross-origin traffic stays network-only", () => {
    const rules = config.match(/runtimeCaching: \[([\s\S]*?)\n {8}\],/)![1];
    expect(rules.match(/urlPattern/g)).toHaveLength(2);
    expect(rules.match(/sameOrigin &&/g)).toHaveLength(2);
    expect(rules).toContain("franken_markdown_bg");
    expect(rules).toContain("kv-storage|replica|profile-gate");
    expect(rules).toContain('handler: "CacheFirst"');
    expect(config).toContain('navigateFallback: "index.html"');
    expect(config).toContain("navigateFallbackDenylist: [/^\\/agents(?:\\/|$)/, /^\\/api(?:\\/|$)/]");
  });

  test("the replication chunks (2.2 MB worker) are not precached: a flag-OFF install never downloads them", () => {
    expect(config).toMatch(/globIgnores: \[[^\]]*"assets\/kv-storage\*\.js"[^\]]*"assets\/replica-\*\.js"[^\]]*"assets\/profile-gate-\*\.js"[^\]]*\]/);
  });

  test("the 7.7 MB notes renderer WASM is not precached: it is fetched on first Preview, never at install", () => {
    expect(config).toMatch(/globIgnores: \[[^\]]*"\*\*\/franken_markdown_bg\*\.wasm"[^\]]*\]/);
  });

  test("the TinyCloud SDK's WASM (a separate asset, TC-2882) is precached: an offline launch can't start the SDK without it", () => {
    expect(config).toMatch(/globPatterns: \[[^\]]*wasm[^\]]*\]/);
    expect(config.match(/globIgnores: \[([^\]]*)\]/)![1]).not.toContain("tinycloud_web_sdk_rs_bg");
  });

  test("an update waits for the user instead of swapping the shell under the page", () => {
    expect(config).toContain('registerType: "prompt"');
    expect(config).toContain("injectRegister: false");
    expect(config).toContain("skipWaiting: false");
  });

  test("Cloudflare Pages never lets sw.js or the manifest go stale", () => {
    const headers = readFileSync(path.join(import.meta.dir, "../../public/_headers"), "utf8");
    expect(headers).toMatch(/^\/sw\.js\n {2}Cache-Control: no-cache$/m);
    expect(headers).toMatch(/^\/manifest\.webmanifest\n {2}Cache-Control: no-cache$/m);
  });
});
