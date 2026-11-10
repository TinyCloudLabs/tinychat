/**
 * The home.tinycloud.xyz build (TC-2387): Home is on unless the visitor turned
 * it off, `/` opens Home, and a signed-out visitor sees a demo feed instead of
 * the sign-in wall. Same codebase and backend as tinycloud.chat.
 */
export const HOME_SITE = import.meta.env.VITE_HOME_SITE === "true";

/** The product name on screen, in the install prompt and in the OpenKey prompt, on every build. */
export const APP_NAME = "TinyCloud Home";
