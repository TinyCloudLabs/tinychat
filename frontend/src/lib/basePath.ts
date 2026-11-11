/**
 * Where the web app is served from: "/" on every deployment, or the sub-path a
 * preview build sets with `vite build --base` (e.g. /cloud-preview/home-feed/).
 * The router and absolute public files follow it. Unset under bun test.
 */
export const BASE_PATH: string = import.meta.env.BASE_URL ?? "/";

/** A file in public/, at the app's base path: "icons/pwa-192.png" → "/icons/pwa-192.png" at the root. */
export function publicUrl(path: string): string {
  return `${BASE_PATH}${path}`;
}
