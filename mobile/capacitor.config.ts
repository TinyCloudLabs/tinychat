import type { CapacitorConfig } from "@capacitor/cli";

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
  ...(devServerUrl && {
    server: {
      url: devServerUrl,
      cleartext: devServerUrl.startsWith("http://"),
    },
  }),
};

export default config;
