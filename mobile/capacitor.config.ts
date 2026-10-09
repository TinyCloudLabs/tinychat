import type { CapacitorConfig } from "@capacitor/cli";
import { KeyboardResize } from "@capacitor/keyboard";

// Live reload: point the native shell at the frontend Vite dev server instead
// of the bundled `frontend/dist`. On the Android emulator, forward the port
// first (`adb reverse tcp:5186 tcp:5186`) so the WebView origin is exactly
// `http://localhost:5186`, one of the backend's allowed CORS origins
// (backend/src/cors-origins.ts). Unset for release builds.
const devServerUrl = process.env.EXO_DEV_SERVER_URL;

const config: CapacitorConfig = {
  appId: "xyz.tinycloud.exo",
  appName: "Exo",
  webDir: "../frontend/dist",
  experimental: {
    ios: {
      spm: {
        swiftToolsVersion: "6.0",
      },
    },
  },
  plugins: {
    // @capacitor/keyboard (the notes UI hides the iOS accessory bar while it is open). Installing it changes iOS
    // app-wide: it takes over the keyboard from WKWebView, and `resize` picks what the web view does. Measured in
    // the iOS simulator against a build without the plugin: "none" leaves the chat composer under the keyboard;
    // "native" shrinks the web view to the room above the keyboard, which keeps the composer clear (and the notes
    // sheet and moment field with it, so the keyboard's height is not needed in JS). The window behind the
    // keyboard is tinted from the page so the resized web view shows no black strip. Android: the plugin only
    // reports events; SystemBars already resizes the view.
    Keyboard: {
      resize: KeyboardResize.Native,
      autoBackdropColor: "dom",
    },
    // Edge-to-edge on both platforms (Android 15+ enforces it): the web view
    // runs under the status bar and gesture bar, and the frontend keeps its
    // chrome clear with env(safe-area-inset-*) padding (index.html sets
    // viewport-fit=cover). iOS needs nothing here: Capacitor's default
    // `ios.contentInset` is "never", so WKWebView reports the insets to CSS.
    SystemBars: {
      // Android WebView 140+ gets the real insets as env() values; older
      // WebViews are padded natively and see 0. Unlike the default "css", this
      // does not also inject --safe-area-inset-* variables, which the frontend
      // does not use. That injection is what logs "Error injecting safe area
      // CSS: TypeError: Cannot read properties of null (reading 'style')" at
      // startup when it runs before the document exists
      // (ionic-team/capacitor#8530).
      insetsHandling: "native",
      // index.html is always viewport-fit=cover, so lay out the first frame
      // that way too instead of padding it and then jumping.
      initialViewportFitValueHint: "cover",
    },
  },
  ...(devServerUrl && {
    server: {
      url: devServerUrl,
      cleartext: devServerUrl.startsWith("http://"),
    },
  }),
};

export default config;
