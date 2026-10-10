import fs from "fs";
import { execFileSync } from "node:child_process";
import path from "path";
import { fileURLToPath } from "url";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { nodePolyfills } from "vite-plugin-node-polyfills";
import { VitePWA } from "vite-plugin-pwa";
import { resolveRecorderFinal } from "./src/capture/recorder/final/recorderFinalFlag";
import { firstNonEmpty } from "./src/lib/buildEnv";

const rootDir = path.dirname(fileURLToPath(import.meta.url));

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

// Modules only the Soft-skin recorder (VITE_EXO_RECORDER_FINAL) can reach. A lazy chunk made only of these is named
// `final-*` (output.chunkFileNames/assetFileNames below), which is what the PWA precache keys on. Eager code that
// imports one of these modules keeps it in the entry chunk, which is never renamed, so a mixed chunk is never `final-`.
const FINAL_ONLY_MODULE = [
  /\/src\/capture\/recorder\/final\//,
  /\/src\/capture\/home\/desktop\//,
  /\/src\/capture\/library\/savedNote\//,
  /\/src\/capture\/meetingSources\//,
  /\/src\/lib\/voiceNotes\/(?:web|desktop)\//,
  /@franken-suite\/franken-markdown\//,
  /\/src\/capture\/recorder\/useRecordedElapsed\./,
  /\/src\/lib\/voiceNotes\/desktopCaptureExtras\./,
];
// CSS files imported only by `final-*` chunks, filled while the bundle is generated (before the service worker is built).
const finalCss = new Set<string>();
const isFinalOnlyModule = (id: string) => FINAL_ONLY_MODULE.some((pattern) => pattern.test(id));

export default defineConfig(({ command, mode }) => {
  // One validated value for the bundle, the precache and the tests: a typo fails the build, not a user's session.
  const recorderFinal = resolveRecorderFinal(loadEnv(mode, rootDir, "VITE_EXO_RECORDER_FINAL"));
  return {
  define: {
    // Defined as "true"/"false" so Rollup folds recorderFinalEnabled() and a flag-off build drops the final-only branches.
    "import.meta.env.VITE_EXO_RECORDER_FINAL": JSON.stringify(String(recorderFinal)),
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
      // Rollup names no CSS file after its chunk's prefix, so the precache learns which CSS belongs to a `final-*` chunk here.
      name: "exo-final-css",
      apply: "build",
      generateBundle(_options, bundle) {
        finalCss.clear();
        for (const chunk of Object.values(bundle)) {
          if (chunk.type !== "chunk" || !chunk.fileName.startsWith("assets/final-")) continue;
          for (const css of chunk.viteMetadata?.importedCss ?? []) finalCss.add(css);
        }
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
        id: "/chat",
        // The product is Exo; the in-app UI still says "TinyCloud Chat" until the rename (TC-526).
        name: "Exo",
        short_name: "Exo",
        description: "Private chat and meeting memory on TinyCloud.",
        start_url: "/chat",
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
        // Precached: index.html, every JS/CSS chunk (lazy ones included, so an offline launch never misses a
        // chunk), the icons and the display font. Left out of it:
        //  - the desktop-only window API chunk (see build.rollupOptions): a web install can never reach it;
        //  - the notes renderer's WASM (7.7 MB, lazy: first Preview), cached at runtime below, so a first
        //    visit never downloads it, with the recorder flag on or off;
        //  - with VITE_EXO_RECORDER_FINAL unset, every `final-*` chunk (see FINAL_ONLY_MODULE): the Soft-skin
        //    recorder, the desktop Capture home, the saved-note page, Meeting sources, the web and desktop
        //    engines and the Markdown renderer. Nothing a flag-off build runs can reach them, so the service
        //    worker must not download them on install. A build with the flag on precaches them, so the
        //    recorder opens offline. Either way a `final-*` chunk that is fetched anyway is cached at runtime.
        // frontend/scripts/flag-off-bundle-check.ts asserts both halves against a built dist/.
        globIgnores: [
          "agents/**",
          "assets/tauri-window-*.js",
          "**/franken_markdown_bg*.wasm",
          ...(recorderFinal ? [] : ["assets/final-*.js"]),
        ],
        manifestTransforms: [
          async (entries) => ({
            manifest: recorderFinal ? entries : entries.filter((entry) => !finalCss.has(entry.url)),
            warnings: [],
          }),
        ],
        // The main chunk carries the TinyCloud SDK's inlined WASM (~7.4 MB today); Workbox skips
        // anything over its 2 MiB default, which would leave the shell unable to boot offline.
        maximumFileSizeToCacheInBytes: 24 * 1024 * 1024,
        // App routes (/, /chat/*) are client-side: serve the precached index.html for navigations.
        navigateFallback: "index.html",
        // ...except the static /agents docs (and /api, should one ever be same-origin). Precached files
        // still win: their route is registered first. Mirrors public/_redirects.
        navigateFallbackDenylist: [/^\/agents(?:\/|$)/, /^\/api(?:\/|$)/],
        // The runtime caches are the notes renderer's own WASM and the `final-*` chunks, same-origin and content-hashed.
        // Everything else outside the precache is not intercepted, so API and cross-origin traffic
        // (api.tinycloud.chat, the TinyCloud nodes, OpenKey, RedPill, Google, Fireflies …) always goes
        // straight to the network, never to a cache.
        runtimeCaching: [
          {
            urlPattern: ({ sameOrigin, url }) => sameOrigin && /\/assets\/final-[^/]+\.js$/.test(url.pathname),
            handler: "CacheFirst",
            options: {
              cacheName: "exo-final-recorder-chunks",
              cacheableResponse: { statuses: [200] },
              expiration: { maxEntries: 40 },
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
        // A lazy chunk that holds only final-only modules is named `final-*` (see FINAL_ONLY_MODULE and the precache).
        chunkFileNames: (chunk) =>
          !chunk.isEntry && chunk.moduleIds.length > 0 && chunk.moduleIds.every(isFinalOnlyModule)
            ? "assets/final-[name]-[hash].js"
            : "assets/[name]-[hash].js",
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
  };
});
