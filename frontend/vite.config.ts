import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { nodePolyfills } from "vite-plugin-node-polyfills";

const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  // The client-side TEE verifier (@redpill-ai/verifier + @peculiar/x509) is
  // Node-oriented and uses `Buffer` for base64↔bytes and ASN.1/cert parsing.
  // Vite externalizes Node builtins in the browser, which silently broke the
  // GPU cert-chain check and an on-chain quote encoding. Polyfill the globals.
  plugins: [
    nodePolyfills({ globals: { Buffer: true, process: true, global: true } }),
    react(),
  ],
  resolve: {
    alias: {
      "@": path.resolve(rootDir, "./src"),
    },
  },
  optimizeDeps: {
    exclude: ["@tinycloud/web-sdk"],
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
