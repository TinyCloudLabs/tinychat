// Feed design rig build: a static site from feed-rig.html with relative URLs, so it can be
// published under any path (scripts/publish-feed-rig.sh). The Home build flag is on, so the
// real Home shell and feed render exactly as on home.tinycloud.xyz. No PWA, no API.
import { createRequire } from "node:module";
import path from "path";
import { fileURLToPath } from "url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { nodePolyfills } from "vite-plugin-node-polyfills";

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const requireFromApp = createRequire(import.meta.url);

export default defineConfig({
  base: "./",
  define: {
    __EXO_BUILD_INFO__: JSON.stringify({ version: "feed-rig", channel: "rig" }),
    "import.meta.env.VITE_HOME_SITE": JSON.stringify("true"),
  },
  plugins: [nodePolyfills({ globals: { Buffer: true, process: true, global: true } }), react()],
  resolve: {
    alias: {
      "vite-plugin-node-polyfills/shims/buffer": requireFromApp.resolve("vite-plugin-node-polyfills/shims/buffer"),
      "vite-plugin-node-polyfills/shims/global": requireFromApp.resolve("vite-plugin-node-polyfills/shims/global"),
      "vite-plugin-node-polyfills/shims/process": requireFromApp.resolve("vite-plugin-node-polyfills/shims/process"),
      "fs/promises": path.resolve(rootDir, "./src/lib/replication/nodeFsPromisesStub.ts"),
      "@tinycloud/node-sdk/core": "@tinycloud/web-sdk",
      // The committed fixture, or the merged copy scripts/publish-feed-rig.sh builds when the private overlay exists.
      "feed-rig-fixture": process.env.FEED_RIG_FIXTURE || path.resolve(rootDir, "./src/feedRig/feed-fixture.json"),
      "@": path.resolve(rootDir, "./src"),
    },
  },
  build: {
    outDir: "dist-feed-rig",
    emptyOutDir: true,
    rollupOptions: { input: { index: path.resolve(rootDir, "feed-rig.html") } },
  },
});
