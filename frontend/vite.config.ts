import fs from "fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "path";
import { fileURLToPath } from "url";
import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { nodePolyfills } from "vite-plugin-node-polyfills";
import { VitePWA } from "vite-plugin-pwa";
import { firstNonEmpty } from "./src/lib/buildEnv";
import { extractInlinedSdkWasm } from "./src/lib/sdkWasmAsset";

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const requireFromApp = createRequire(import.meta.url);

// The build line's baseline (TC-840): the shared web/desktop/mobile version
// frontend/package.json owns, the commit being built, and the channel
// (VITE_EXO_CHANNEL for the pipeline; `vite dev` reports "dev"). The pipeline
// may also inject VITE_EXO_BUILD_NUMBER (the desktop build does: its
// CFBundleVersion); native builds read their own numbers at runtime.
// package.json is a known file: the cast names its one field, nothing else.
const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf8")) as { version?: string };
const exoBuildInfo = {
  version: pkg.version,
  // First non-empty wins: an exported-but-empty variable must not shadow the fallbacks.
  commit: firstNonEmpty(
    process.env.VITE_EXO_BUILD_COMMIT,
    process.env.CF_PAGES_COMMIT_SHA,
    process.env.GITHUB_SHA,
    (() => {
      try {
        return execFileSync("git", ["rev-parse", "HEAD"], { cwd: rootDir }).toString().trim();
      } catch {
        return undefined;
      }
    })(),
  ),
  build: firstNonEmpty(process.env.VITE_EXO_BUILD_NUMBER),
  channel: firstNonEmpty(process.env.VITE_EXO_CHANNEL),
};

export default defineConfig(({ command, mode }) => {
  if (command === "build") {
    const origin = loadEnv(mode, rootDir, "VITE_").VITE_EXO_PTX_UPLOAD_ORIGIN;
    let valid = false;
    try {
      const url = new URL(origin);
      valid = url.protocol === "https:" && !!url.hostname && !url.username && !url.password
        && !url.search && !url.hash && url.pathname === "/"
        && origin.replace(/\/$/, "") === url.origin;
    } catch { /* invalid origin */ }
    if (!valid)
      throw new Error("VITE_EXO_PTX_UPLOAD_ORIGIN must be a bare HTTPS origin for production builds");
  }
  return ({
  define: {
    __EXO_BUILD_INFO__: JSON.stringify({ ...exoBuildInfo, channel: exoBuildInfo.channel ?? (command === "serve" ? "dev" : undefined) }),
  },
  // The client-side TEE verifier (@redpill-ai/verifier + @peculiar/x509) is
  // Node-oriented and uses `Buffer` for base64↔bytes and ASN.1/cert parsing.
  // Vite externalizes Node builtins in the browser, which silently broke the
  // GPU cert-chain check and an on-chain quote encoding. Polyfill the globals.
  plugins: [
    {
      name: "tinychat-agent-artifacts",
      apply: "build",
      buildStart() {
        for (const script of ["build-agent-skills.mjs", "build-agent-setup.mjs"]) {
          execFileSync("node", [path.join(rootDir, "../scripts", script)], { stdio: "inherit" });
        }
      },
    },
    {
      // tinycloud.chat moves a visitor to home.tinycloud.xyz only once this file there names the commit the
      // visitor's bundle was built from (src/lib/originMove.ts `canonicalServesThisBuild`).
      name: "tinychat-version-json",
      apply: "build",
      generateBundle() {
        this.emitFile({ type: "asset", fileName: "version.json", source: `${JSON.stringify({ commit: exoBuildInfo.commit ?? null })}\n` });
      },
    },
    (() => {
      // The TinyCloud SDK's WASM as its own file (assets/tinycloud_web_sdk_rs_bg-*.wasm) instead of 1.9 MB of base64
      // in the entry chunk that is decoded at module evaluation (TC-2882, src/lib/sdkWasmAsset.ts). index.html
      // preloads it, so it arrives while the entry chunk is still parsing, and wasm-bindgen then fetches it. The web
      // precaches it (globPatterns); the Capacitor and Tauri shells serve it from the app bundle, as they do
      // franken-markdown's WASM. `vite dev` keeps it inline.
      const wasmName = "tinycloud_web_sdk_rs_bg.wasm";
      return {
        name: "tinycloud-sdk-wasm-asset",
        apply: "build",
        enforce: "pre",
        transform(code, id) {
          if (!/[\\/]@tinycloud[\\/]web-sdk[\\/]dist[\\/]index\.mjs$/.test(id)) return null;
          const extracted = extractInlinedSdkWasm(code, (base64) =>
            `import.meta.ROLLUP_FILE_URL_${this.emitFile({ type: "asset", name: wasmName, source: Buffer.from(base64, "base64") })}`);
          return extracted && { code: extracted.code, map: null };
        },
        transformIndexHtml: {
          order: "post",
          handler(_html, { bundle }) {
            const wasm = Object.values(bundle ?? {}).find((file) => file.type === "asset" && file.names.includes(wasmName));
            // Same mode and credentials as wasm-bindgen's fetch(), so the preloaded response is reused.
            return wasm && [{ tag: "link", attrs: { rel: "preload", href: `/${wasm.fileName}`, as: "fetch", crossorigin: "anonymous" }, injectTo: "head" }];
          },
        },
      } satisfies Plugin;
    })(),
    {
      // Open the connections to the TinyCloud node and the backend while the bundle loads, so the
      // first request after sign-in restore does not also pay DNS, TCP and TLS (two round trips to
      // the node's gateway). Only origins this build is configured with; dev without them adds none.
      name: "tinychat-preconnect",
      transformIndexHtml() {
        const env = loadEnv(mode, rootDir, "VITE_");
        const origins = [env.VITE_TINYCLOUD_HOST, env.VITE_BACKEND_URL].flatMap((value) => {
          try { return value ? [new URL(value).origin] : []; } catch { return []; }
        });
        // The SDK's fetches are CORS without credentials: `crossorigin` makes the preconnected socket the one they use.
        return [...new Set(origins)].flatMap((href) => [
          { tag: "link", attrs: { rel: "preconnect", href, crossorigin: "" }, injectTo: "head-prepend" as const },
          { tag: "link", attrs: { rel: "dns-prefetch", href }, injectTo: "head-prepend" as const },
        ]);
      },
    },
    nodePolyfills({ globals: { Buffer: true, process: true, global: true } }),
    react(),
    // Installable web app (PWA). Builds dist/manifest.webmanifest (linked from index.html) and a Workbox
    // service worker, dist/sw.js, that precaches the app shell. Registration is ours, not the plugin's
    // (src/lib/pwa.ts): the same dist is bundled into the Tauri and Capacitor shells, which must never
    // register it, and an update waits for the user's "Reload" instead of swapping the shell under them.
    VitePWA({
      registerType: "prompt",
      injectRegister: false,
      // `vite dev` serves no worker unless VITE_PWA_DEV=true (src/lib/pwa.ts checks the same flag).
      devOptions: { enabled: process.env.VITE_PWA_DEV === "true" },
      manifest: {
        // home.tinycloud.xyz's installed-app id since TC-2387, so existing Home installs stay one app.
        id: "/chat/feed",
        name: "TinyCloud Home",
        short_name: "Home",
        description: "Your feed, chat, recordings and apps, in your TinyCloud space.",
        // `/` opens the first screen the user chose (Feed unless they picked Apps).
        start_url: "/",
        scope: "/",
        display: "standalone",
        // A manifest takes one color: Day's --background (lib/theme.ts THEME_COLOR). index.html's
        // theme-color metas follow light/dark at runtime.
        theme_color: "#FFFFFF",
        background_color: "#FFFFFF",
        categories: ["productivity"],
        // Generated by mobile/scripts/brand-assets.py from the same mark as the mobile app icons.
        icons: [
          { src: "/icons/pwa-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
          { src: "/icons/pwa-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
          { src: "/icons/maskable-192.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
          { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      // globPatterns below already picks up the icons and the manifest.
      includeManifestIcons: false,
      workbox: {
        // Precache the app shell only: index.html, every JS/CSS chunk (lazy ones included, so an
        // offline launch never misses a chunk), the icons and the display font. /agents/* is
        // published docs, not the app.
        globPatterns: ["**/*.{html,js,css,wasm,png,svg,ico,webmanifest,woff2}"],
        // The desktop-only window API chunk (see build.rollupOptions): a web install can never reach it.
        // The notes renderer's WASM (7.7 MB, lazy: first Preview) is cached at runtime below, so a
        // first visit never downloads it.
        // The local-replication chunks (kv-storage + its 2.2 MB worker, replica, profile-gate) are only
        // fetched when the replication flag is ON (lazy import in lib/replication); runtime-cached below.
        globIgnores: [
          "agents/**", "assets/tauri-window-*.js", "**/franken_markdown_bg*.wasm",
          "assets/kv-storage*.js", "assets/replica-*.js", "assets/profile-gate-*.js",
        ],
        // The main chunk (~7.4 MB, most of it the TinyCloud SDK) and the SDK's WASM (1.4 MB) are needed to boot;
        // Workbox skips anything over its 2 MiB default, which would leave the shell unable to boot offline.
        maximumFileSizeToCacheInBytes: 24 * 1024 * 1024,
        // App routes (/, /chat/*) are client-side: serve the precached index.html for navigations.
        navigateFallback: "index.html",
        // ...except the static /agents docs (and /api, should one ever be same-origin). Precached files
        // still win: their route is registered first. Mirrors public/_redirects.
        navigateFallbackDenylist: [/^\/agents(?:\/|$)/, /^\/api(?:\/|$)/],
        // The runtime caches are the notes renderer's WASM and the replication chunks, same-origin and content-hashed.
        // Everything else outside the precache is not intercepted, so API and cross-origin traffic
        // (api.tinycloud.chat, the TinyCloud nodes, OpenKey, RedPill, Google, Fireflies …) always goes
        // straight to the network, never to a cache.
        runtimeCaching: [
          {
            urlPattern: ({ sameOrigin, url }) =>
              sameOrigin && /\/assets\/(?:kv-storage|replica|profile-gate)[^/]*\.js$/.test(url.pathname),
            handler: "CacheFirst",
            options: {
              cacheName: "exo-replication-chunks",
              cacheableResponse: { statuses: [200] },
              expiration: { maxEntries: 8 },
            },
          },
          {
            urlPattern: ({ sameOrigin, url }) =>
              sameOrigin && /\/franken_markdown_bg[^/]*\.wasm$/.test(url.pathname),
            handler: "CacheFirst",
            options: {
              cacheName: "exo-notes-renderer-wasm",
              cacheableResponse: { statuses: [200] },
              expiration: { maxEntries: 2 },
            },
          },
        ],
        cleanupOutdatedCaches: true,
        // The first install takes control at once (so the next offline launch works); an UPDATE
        // waits (skipWaiting: false) until the page asks for it — see src/lib/pwa.ts.
        clientsClaim: true,
        skipWaiting: false,
      },
    }),
  ],
  resolve: {
    alias: {
      // Linked SDK modules still need the app's installed browser-global polyfills.
      "vite-plugin-node-polyfills/shims/buffer": requireFromApp.resolve("vite-plugin-node-polyfills/shims/buffer"),
      "vite-plugin-node-polyfills/shims/global": requireFromApp.resolve("vite-plugin-node-polyfills/shims/global"),
      "vite-plugin-node-polyfills/shims/process": requireFromApp.resolve("vite-plugin-node-polyfills/shims/process"),
      // @tinycloud/replica/profile-gate (pulled in by web-sdk/replica) imports Node's fs/promises at
      // top level; the polyfill plugin only shims `fs`, which breaks the build. See the stub.
      "fs/promises": path.resolve(rootDir, "./src/lib/replication/nodeFsPromisesStub.ts"),
      // Redirect @tinycloud/node-sdk/core → @tinycloud/web-sdk in the browser
      // bundle. agentDelegation.ts imports serializeDelegation from node-sdk/core
      // (to avoid web-sdk's HTMLElement at test load time), but node-sdk/core
      // bundles Node.js file-system code (existsSync, path.join) that can't work
      // in a Vite browser build. web-sdk re-exports serializeDelegation without
      // the Node.js deps, so it's the right target for the browser build.
      // In bun test (where HTMLElement is absent) this alias does NOT apply, so
      // tests continue using node-sdk/core as intended.
      "@tinycloud/node-sdk/core": "@tinycloud/web-sdk",
      "@": path.resolve(rootDir, "./src"),
    },
  },
  optimizeDeps: {
    exclude: ["@tinycloud/web-sdk"],
  },
  build: {
    rollupOptions: {
      output: {
        // The Tauri window API is reached only from the desktop app's recording title (a lazy import).
        // Naming its chunk lets the web PWA precache leave it out (globIgnores below). core and event
        // are shared with code the web can load, so they get their own chunk rather than being pulled in.
        manualChunks: (id) => {
          const tauri = /node_modules\/@tauri-apps\/api\/(\w+)\.js$/.exec(id)?.[1];
          if (tauri === "window" || tauri === "image" || tauri === "dpi") return "tauri-window";
          if (tauri === "core" || tauri === "event") return "tauri-core";
          return undefined;
        },
      },
    },
  },
  server: {
    port: 5186,
    allowedHosts: true,
    ...(fs.existsSync("./localhost.pem") && {
      https: {
        key: fs.readFileSync("./localhost-key.pem"),
        cert: fs.readFileSync("./localhost.pem"),
      },
    }),
  },
  });
});
