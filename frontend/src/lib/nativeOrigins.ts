/**
 * The origins the phone apps' WebViews serve the bundled frontend from, set by `server.hostname`,
 * `androidScheme` and `iosScheme` in mobile/capacitor.config.ts. They are the apps' own: nothing
 * is ever served at app.tinycloud.one (TC-3045). mobile/webview-origin.test.ts fails CI if the
 * config, these and the backend's CORS origins (backend/src/cors-origins.ts) ever differ.
 */
export const NATIVE_WEBVIEW_HOSTNAME = "app.tinycloud.one";
export const ANDROID_WEBVIEW_ORIGIN = "https://app.tinycloud.one";
export const IOS_WEBVIEW_SCHEME = "tinycloudone";
export const IOS_WEBVIEW_ORIGIN = "tinycloudone://app.tinycloud.one";
