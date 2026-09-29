import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: [
      "**/dist/",
      "**/node_modules/",
      // Rust build output — eslint tries to parse CMake compiler_depend.ts files.
      "desktop/src-tauri/target/",
      "**/*.js",
      "**/*.mjs",
      // Vendored verbatim from redpill-ai/redpill-verifier (see VENDOR.md); kept
      // byte-identical to upstream except the two forked fetch URLs, so it is not linted.
      "frontend/src/lib/vendor/",
      // Vendored verbatim tauri-specta bindings from fastrepl/anarlog @864ddc1
      // (see frontend/src/lib/anarlog/PROVENANCE.md); kept byte-identical, not linted.
      "frontend/src/lib/anarlog/",
    ],
  },
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
  {
    files: ["**/src/types/**/*.ts"],
    rules: {
      "@typescript-eslint/no-namespace": "off",
    },
  },
);
