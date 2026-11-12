// Used by vite.config.ts (`tinycloud-sdk-wasm-asset`, TC-2882). The published @tinycloud/web-sdk bundle
// (dist/index.mjs) carries its 1.4 MB WASM as a ~1.9 MB base64 string that the entry chunk decodes at
// module evaluation. The build moves those bytes into a separately fetched asset and hands wasm-bindgen
// its URL instead, the same way franken-markdown loads its WASM.

/** The base64 of a WASM binary starts with its magic number, `\0asm`. */
const WASM_BASE64_LITERAL = /"(AGFzbQ[A-Za-z0-9+/=]*)"/;
const INIT_ARGUMENT = "module_or_path:";

export type InlinedSdkWasm = {
  /** The inlined WASM, base64. */
  base64: string;
  /** `code` with wasm-bindgen's init argument replaced by the URL expression. */
  code: string;
};

/**
 * Finds the WASM the SDK inlines as `module_or_path: <decode IIFE>(…, "<base64>", …)` and replaces that IIFE
 * with the URL expression `urlFor` returns for those bytes (wasm-bindgen then fetches it). Null when the code
 * carries no inlined WASM. Throws when it does but not in that shape, so an SDK upgrade can't silently put it
 * back into the entry chunk.
 */
export function extractInlinedSdkWasm(code: string, urlFor: (base64: string) => string): InlinedSdkWasm | null {
  const literal = WASM_BASE64_LITERAL.exec(code);
  if (!literal) return null;
  const argumentStart = code.lastIndexOf(INIT_ARGUMENT, literal.index);
  const decoder = argumentStart < 0 ? "" : code.slice(argumentStart + INIT_ARGUMENT.length, literal.index);
  const callEnd = code.indexOf(")", literal.index + literal[0].length);
  if (argumentStart < 0 || !decoder.startsWith("function(") || !decoder.includes("atob(") || callEnd < 0
    || code.slice(literal.index + literal[0].length, callEnd).trim() !== ",void 0") {
    throw new Error("@tinycloud/web-sdk inlines its WASM in an unrecognised form: update extractInlinedSdkWasm (src/lib/sdkWasmAsset.ts)");
  }
  return {
    base64: literal[1],
    code: code.slice(0, argumentStart + INIT_ARGUMENT.length) + urlFor(literal[1]) + code.slice(callEnd + 1),
  };
}
