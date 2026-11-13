import type { Plugin } from "vite";

// Used by vite.config.ts (TC-2935). @stablelib/random (siwe's nonce helper, reached from the SDK at boot) declares
// `"browser": { "crypto": false }`: in a browser it draws from crypto.getRandomValues and never uses its Node
// fallback. vite-plugin-node-polyfills' `crypto` alias overrode that and put all of crypto-browserify (elliptic,
// bn.js, readable-stream, asn1.js …) in the entry chunk. This plugin honours the package's own browser field there,
// and only there: other importers of `crypto` keep the polyfill.

const EMPTY_CRYPTO = "\0stablelib-browser-crypto";

export function stablelibBrowserCrypto(): Plugin {
  return {
    name: "tinychat-stablelib-browser-crypto",
    // Before Vite's resolver; the polyfills' alias has already turned `crypto` into crypto-browserify's path.
    enforce: "pre",
    resolveId(source, importer) {
      if (!importer || !/[\\/]@stablelib[\\/]random[\\/]/.test(importer)) return null;
      return source === "crypto" || /[\\/]crypto-browserify(?:[\\/]|$)/.test(source) ? EMPTY_CRYPTO : null;
    },
    load(id) {
      return id === EMPTY_CRYPTO ? "export default {};" : null;
    },
  };
}
