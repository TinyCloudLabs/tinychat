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
    expect(serviceWorkerDecision({ ...web, protocol: "capacitor:", hostname: "localhost", hasServiceWorker: false })).toBe(
      "skip:capacitor",
    );
    // Android bundle: https://localhost, where the WebView WOULD allow a worker.
    expect(serviceWorkerDecision({ ...web, hostname: "localhost" })).toBe("skip:capacitor");
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

  test("the worker caches only the notes renderer's WASM and the final-* chunks at runtime: API and cross-origin traffic stays network-only", () => {
    const rules = config.match(/runtimeCaching: \[([\s\S]*?)\n {8}\],/)![1];
    expect(rules.match(/urlPattern/g)).toHaveLength(2);
    expect(rules.match(/sameOrigin &&/g)).toHaveLength(2);
    expect(rules).toContain("franken_markdown_bg");
    expect(rules).toContain("assets\\/final-");
    expect(rules).toContain('handler: "CacheFirst"');
    expect(config).toContain('navigateFallback: "index.html"');
    expect(config).toContain("navigateFallbackDenylist: [/^\\/agents(?:\\/|$)/, /^\\/api(?:\\/|$)/]");
  });

  test("the 7.7 MB notes renderer WASM is not precached: it is fetched on first Preview, never at install", () => {
    expect(config).toMatch(/globIgnores: \[[^\]]*"\*\*\/franken_markdown_bg\*\.wasm"[^\]]*\]/);
  });

  test("the final-only chunks join the precache only when the build turns the recorder flag on", () => {
    expect(config).toContain('...(recorderFinal ? [] : ["assets/final-*.js"])');
    expect(config).toContain("recorderFinal ? entries : entries.filter((entry) => !finalCss.has(entry.url))");
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
