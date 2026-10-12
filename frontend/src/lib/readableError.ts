/** Render SDK result errors and thrown values without JavaScript's `[object Object]`. */
export function readableError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (error && typeof error === "object") {
    const value = error as Record<string, unknown>;
    const parts = [value.code, value.message, value.status ?? (value.meta as { status?: unknown } | undefined)?.status]
      .filter((part) => typeof part === "string" || typeof part === "number")
      .map(String).filter(Boolean);
    if (parts.length) return [...new Set(parts)].join(": ");
    try {
      return JSON.stringify(error, (key, entry) =>
        /^(?:d|siwe|signature|token|accessToken|refreshToken|privateKey|secret|authorization|apiKey)$/i.test(key)
          ? "<redacted>" : entry) ?? "Unknown error";
    } catch { return "Unknown error"; }
  }
  return String(error);
}
