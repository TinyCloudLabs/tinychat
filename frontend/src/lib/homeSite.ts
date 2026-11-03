/**
 * The home.tinycloud.xyz build (TC-2387): Home is on unless the visitor turned
 * it off, `/` opens Home, and a signed-out visitor sees a demo feed instead of
 * the sign-in wall. Same codebase and backend as tinycloud.chat.
 */
export const HOME_SITE = import.meta.env.VITE_HOME_SITE === "true";

/** The product name on screen, in the install prompt and in the OpenKey prompt. */
export function appNameFor(homeSite: boolean): string {
  return homeSite ? "TinyCloud Home" : "Exo";
}

export const APP_NAME = appNameFor(HOME_SITE);
