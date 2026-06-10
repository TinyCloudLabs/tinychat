import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: [
      "**/dist/",
      "**/node_modules/",
      "**/*.js",
      "**/*.mjs",
      // Vendored verbatim from redpill-ai/redpill-verifier (see VENDOR.md); kept
      // byte-identical to upstream except the two forked fetch URLs, so it is not linted.
      "frontend/src/lib/vendor/",
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
