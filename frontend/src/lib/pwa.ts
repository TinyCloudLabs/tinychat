/**
 * Exo as an installable web app (PWA): service worker registration, the update
 * prompt and the install prompt.
 *
 * The worker itself is built by vite-plugin-pwa (vite.config.ts): it precaches
 * the app shell and serves index.html for app navigations, and intercepts
 * nothing else — API and cross-origin traffic never touches a cache.
 *
 * Registration is decided here, before React renders, because the same
 * frontend/dist is bundled into the native shells, which must never register
 * it: Capacitor (capacitor://localhost on iOS, https://localhost on Android,
 * or the Vite dev server for live reload) and Tauri (tauri://localhost,
 * http://tauri.localhost). Their WebViews already serve the bundle from disk,
 * and a worker there would only pin a stale shell over a fresh app update.
 *
 * Updates: a new worker installs in the background and WAITS. The page shows
 * "New version available — Reload"; Reload tells the waiting worker to take
 * over and reloads once it has. Ignoring the prompt is safe too: the new
 * worker takes over by itself once every Exo tab is closed, so the next launch
 * runs the new version. Nothing ever swaps the shell under a running page
 * (a reload mid-recording would lose the voice note).
 */

export type ServiceWorkerDecision =
  | "register"
  | "skip:unsupported"
  | "skip:capacitor"
  | "skip:tauri"
  | "skip:dev";

export interface ServiceWorkerEnvironment {
  /** `"serviceWorker" in navigator` (false on insecure origins and custom schemes). */
  hasServiceWorker: boolean;
  /** `Capacitor.isNativePlatform()`. */
  isCapacitorNative: boolean;
  /** `"__TAURI_INTERNALS__" in window`. */
  isTauri: boolean;
  /** `location.protocol`, e.g. "https:". */
  protocol: string;
  /** `location.hostname`. */
  hostname: string;
  /** `location.port` ("" for the scheme's default port). */
  port: string;
  /** `import.meta.env.DEV`. */
  dev: boolean;
  /** VITE_PWA_DEV === "true": opt in to the worker under `vite dev`. */
  devEnabled: boolean;
}

/** Whether this page may register the service worker, and if not, why. */
export function serviceWorkerDecision(env: ServiceWorkerEnvironment): ServiceWorkerDecision {
  // The shells are checked first and by more than one signal: the runtime flags
  // are authoritative, the origins are a backstop should a flag ever be missing.
  if (env.isCapacitorNative) return "skip:capacitor";
  if (env.isTauri) return "skip:tauri";
  if (env.protocol === "capacitor:") return "skip:capacitor";
  if (env.protocol === "tauri:" || env.hostname === "tauri.localhost") return "skip:tauri";
  // Capacitor Android serves the bundle from https://localhost (no port). A
  // local `vite preview` always has a port, so it still registers.
  if (env.protocol === "https:" && env.hostname === "localhost" && env.port === "") return "skip:capacitor";
  if (!env.hasServiceWorker) return "skip:unsupported";
  if (env.dev && !env.devEnabled) return "skip:dev";
  return "register";
}

// ── Prompt state (one tiny external store for useSyncExternalStore) ──────────

/** Chromium's install prompt event (not in lib.dom). */
export interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
}

export interface PwaState {
  /** A new version is installed and waiting for "Reload". */
  updateReady: boolean;
  /** Chromium offered to install the app (never on iOS, never once installed). */
  canInstall: boolean;
}

let state: PwaState = { updateReady: false, canInstall: false };
const listeners = new Set<() => void>();
let installEvent: BeforeInstallPromptEvent | null = null;
let waitingWorker: ServiceWorker | null = null;

function setState(patch: Partial<PwaState>) {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

export function subscribePwa(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getPwaState(): PwaState {
  return state;
}

/** Running as an installed app (standalone window or iOS home screen). */
export function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  const nav = navigator as Navigator & { standalone?: boolean };
  return (
    nav.standalone === true ||
    window.matchMedia?.("(display-mode: standalone)").matches === true ||
    window.matchMedia?.("(display-mode: window-controls-overlay)").matches === true
  );
}

/** Show Chromium's install dialog. Resolves true when the user installed. */
export async function promptInstall(): Promise<boolean> {
  const event = installEvent;
  if (!event) return false;
  installEvent = null;
  setState({ canInstall: false });
  await event.prompt();
  const choice = await event.userChoice;
  return choice.outcome === "accepted";
}

let reloading = false;

/** "Reload": let the waiting worker take over, then reload into the new version. */
export function applyUpdate(): void {
  const worker = waitingWorker;
  reloading = true;
  if (!worker) {
    window.location.reload();
    return;
  }
  // Workbox's generated worker (skipWaiting: false) listens for exactly this.
  worker.postMessage({ type: "SKIP_WAITING" });
}

// ── Registration ───────────────────────────────────────────────────────────

/** How often a long-lived page checks for a new version. */
const UPDATE_INTERVAL_MS = 60 * 60 * 1000;
/** Coming back to the page checks too, at most this often. */
const FOCUS_UPDATE_MIN_GAP_MS = 5 * 60 * 1000;

function watchForUpdates(registration: ServiceWorkerRegistration) {
  const offerUpdate = (worker: ServiceWorker | null) => {
    // No controller = the first install, not an update: nothing to reload into.
    if (!worker || !navigator.serviceWorker.controller) return;
    waitingWorker = worker;
    setState({ updateReady: true });
  };
  offerUpdate(registration.waiting);
  registration.addEventListener("updatefound", () => {
    const installing = registration.installing;
    if (!installing) return;
    installing.addEventListener("statechange", () => {
      if (installing.state === "installed") offerUpdate(registration.waiting ?? installing);
    });
  });

  // Only a reload the user asked for. The first install's clientsClaim also
  // fires controllerchange, and must not reload the page.
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (reloading) window.location.reload();
  });

  let lastCheck = Date.now();
  const check = () => {
    if (!navigator.onLine) return;
    lastCheck = Date.now();
    registration.update().catch(() => {
      // Offline or a deploy in flight: the next check retries.
    });
  };
  window.setInterval(check, UPDATE_INTERVAL_MS);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && Date.now() - lastCheck > FOCUS_UPDATE_MIN_GAP_MS) check();
  });
}

/**
 * Decide, record and (on the web) register. Call once, before rendering. The
 * decision lands on <html data-exo-sw="…"> so the shells' smoke tests (and
 * anyone debugging) can see it.
 */
export function setupPwa(env: ServiceWorkerEnvironment): ServiceWorkerDecision {
  const decision = serviceWorkerDecision(env);
  document.documentElement.dataset.exoSw = decision;
  if (decision !== "register") return decision;

  window.addEventListener("beforeinstallprompt", (event) => {
    // Keep Chromium's mini-infobar quiet; the app shows its own "Install Exo".
    event.preventDefault();
    installEvent = event as BeforeInstallPromptEvent;
    setState({ canInstall: !isStandalone() });
  });
  window.addEventListener("appinstalled", () => {
    installEvent = null;
    setState({ canInstall: false });
  });

  // vite-plugin-pwa serves the dev worker under a different name.
  const url = env.dev ? "/dev-sw.js?dev-sw" : "/sw.js";
  const register = () => {
    navigator.serviceWorker
      .register(url, { scope: "/", updateViaCache: "none" })
      .then(watchForUpdates)
      .catch((error: unknown) => {
        console.warn("[exo] service worker registration failed", error);
      });
  };
  // After load, so the worker's precache download does not compete with boot.
  if (document.readyState === "complete") register();
  else window.addEventListener("load", register, { once: true });
  return decision;
}
