// The native location plugin of the TC-524 spike, implemented by the Exo mobile
// shell: mobile/android/.../location/LocationPlugin.java and
// mobile/ios/App/App/LocationPlugin.swift. It exists only in debug builds of the
// app (Android: the debug manifest declares the permissions; iOS: the plugin is
// compiled into Debug only), and the UI only with VITE_EXO_LOCATION_SPIKE=true.
// `nativeLocationAvailable()` is the one gate every caller checks first.
//
// Data flow: the OS delivers fixes to native code, which appends them (and every
// OS-state change while capture is on) to an on-device queue. The web layer
// drains that queue into the user's TinyCloud space (locationStore.ts) and acks
// what it saved. The WebView may be suspended (iOS background) or gone (Android
// activity destroyed while the foreground service runs, iOS background relaunch),
// so the queue, not the live events, is the source of truth.

import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core";

/**
 * The permission level the OS reports.
 *  - `prompt`: never asked (or asking is still possible).
 *  - `denied`: refused; on Android "don't ask again", on iOS any refusal. Only Settings can change it.
 *  - `restricted`: iOS only, parental controls or MDM.
 *  - `foreground`: while using the app (iOS When In Use; Android "While using the app" or "Only this time";
 *    neither OS tells the app which of the last two).
 *  - `background`: all the time (iOS Always; Android ACCESS_BACKGROUND_LOCATION).
 */
export type LocationPermission = "prompt" | "denied" | "restricted" | "foreground" | "background";

/** Precise (GPS-level) or approximate (about 1-3 km on Android, a few km on iOS), chosen by the user at the prompt. */
export type LocationAccuracy = "precise" | "approximate";

/**
 * What asking for "all the time" does right now.
 *  - `granted`: already has it.
 *  - `foreground_first`: ask for while-in-use first (both OSes require the order).
 *  - `dialog`: Android 10, an in-app dialog with "Allow all the time".
 *  - `settings`: Android 11+ (the request opens Settings), or iOS after the one-time upgrade prompt was used.
 *  - `upgrade_prompt`: iOS, the one-time "Change to Always Allow" prompt is still available.
 */
export type BackgroundRequest = "granted" | "foreground_first" | "dialog" | "settings" | "upgrade_prompt";

/**
 * - `continuous`: a live trail. Android: high-accuracy (precise) or balanced (approximate) updates; iOS: standard
 *   location updates, plus significant changes as a wake-up net when Always.
 * - `low_power`: place-level. Android: low-power quality, 5 min / 100 m by default; iOS: significant-change
 *   (about 500 m, at most every 5 min) and visits.
 */
export type LocationMode = "continuous" | "low_power";

/** Fields whose change is a "state" event (and, while capture is on, a queued entry). */
export interface LocationOsSummary {
  permission: LocationPermission;
  /** null while there is no permission. */
  accuracy: LocationAccuracy | null;
  /** Location services (the system-wide switch) on. */
  servicesEnabled: boolean;
  /** Android battery saver / iOS Low Power Mode. */
  lowPowerMode: boolean;
  /** Whether the app is on screen. Android stops delivering to a while-in-use app with no foreground service once it is not. */
  appVisible: boolean;
  /** Android 9+: what battery saver does to location (e.g. `gps_disabled_when_screen_off`, `foreground_only`). */
  locationPowerSaveMode?: string | null;
  /** Android: Doze. */
  deviceIdle?: boolean;
  /** Android 13+: whether the foreground service's notification can show at all. */
  notificationsEnabled?: boolean;
  /** iOS: Background App Refresh (`available` / `denied` / `restricted`). */
  backgroundRefresh?: string;
}

export interface LocationTrackingState {
  /** The user turned capture on and has not turned it off (persisted across process death). */
  desired: boolean;
  /** Location updates are registered with the OS right now. */
  active: boolean;
  mode: LocationMode;
  /** Keep capturing after the user leaves the app (Android: location foreground service; iOS: background updates). */
  background: boolean;
  /** Android providers (`fused`, `gps`, `network`, `passive`) or iOS services (`standard`, `significant_change`, `visits`). */
  sources: string[];
  /** Android only; iOS has no interval control (distance filter only). */
  intervalMs: number | null;
  distanceM: number;
  startedAt: number | null;
  lastSampleAt: number | null;
  /** Samples since this process started the capture. */
  sessionSamples: number;
  /** iOS: the OS paused updates (`pausesLocationUpdatesAutomatically`); they resume only in the foreground or on a significant change. */
  pausedByOs: boolean;
  /** Why the last capture ended: `stopped`, `stopped_from_notification`, `fgs_start_denied`, `service_destroyed`, `process_restarted`. */
  lastStopReason: string | null;
  /** Android: the location foreground service is running. */
  foregroundService?: boolean;
}

export interface LocationStatus extends LocationOsSummary {
  platform: "android" | "ios";
  /** Random per install; keys the device's batches in the space. */
  installId: string;
  backgroundRequest: BackgroundRequest;
  /** What this build declares. All false in a release build: the spike is debug-only. */
  declared: {
    foreground: boolean;
    background: boolean;
    /** Android: the location foreground service; iOS: UIBackgroundModes `location`. */
    backgroundExecution: boolean;
    /** Android: ACCESS_FINE_LOCATION. */
    precise?: boolean;
  };
  tracking: LocationTrackingState;
  queue: { pending: number; dropped: number };
  android?: {
    sdkInt: number;
    /** Android 11+: the localized label of the Settings option, e.g. "Allow all the time". */
    backgroundOptionLabel?: string | null;
    /** Each provider the device has, and whether it is enabled. */
    providers: Record<string, boolean>;
    ignoringBatteryOptimizations?: boolean;
    /** Android 9+: the user restricted the app's background battery use. */
    backgroundRestricted?: boolean;
  };
  ios?: {
    authorizationStatus: string;
    backgroundRefresh: string;
    significantChangeAvailable: boolean;
    allowsBackgroundLocationUpdates: boolean;
    systemVersion: string;
  };
}

/** One fix (or, on iOS, a visit), as the native queue stores it. */
export interface LocationSample {
  kind: "sample";
  /** Queue position; present on queued entries and live events. */
  seq?: number;
  /** When the OS took the fix (ms since epoch). */
  at: number;
  /** When the app received it. A large gap means the OS delivered late or in a batch. */
  receivedAt: number;
  lat: number;
  lon: number;
  accuracyM: number | null;
  altitudeM?: number | null;
  verticalAccuracyM?: number | null;
  speedMps?: number | null;
  bearingDeg?: number | null;
  /** Android provider, or the iOS source: `standard`, `significant_change`, `visit`. */
  provider: string | null;
  /** Android `Location.isMock()`; iOS `sourceInformation.isSimulatedBySoftware`. */
  mock: boolean;
  accuracyAuthorization: LocationAccuracy;
  mode: LocationMode;
  appVisible: boolean;
  /** iOS visits only. */
  arrivalAt?: number | null;
  departureAt?: number | null;
}

/**
 * What changed: an OS-reported state (`permission`, `accuracy`, `services`, `power`, `visibility`,
 * `notifications`), a provider switching (`provider`), the capture itself (`tracking`: started, stopped,
 * paused_by_os, resumed, process_restarted, restarted_by_os, relaunched_for_location, fgs_start_denied,
 * service_destroyed) or an `error`.
 */
export interface LocationStateEvent {
  kind: "state";
  seq?: number;
  at: number;
  change: string;
  reason: string | null;
  /** The summary fields that changed, for an OS-reported change. */
  changed?: string[];
  detail?: string;
  state: LocationOsSummary;
}

export type LocationQueueEntry = (LocationSample | LocationStateEvent) & { seq: number };

export interface LocationStartOptions {
  mode: LocationMode;
  background: boolean;
  /** Android only: `auto` (fused on API 31+, else gps + network), or force one provider. */
  provider?: "auto" | "fused" | "gps" | "network" | "passive";
  /** Android only. */
  intervalMs?: number;
  distanceM?: number;
}

export interface LocationPlugin {
  status(): Promise<LocationStatus>;
  /**
   * One step of the permission ladder. `foreground` first; `background` only after it (Android 11+ opens
   * Settings, iOS shows its one-time upgrade prompt). Resolves with the status once the user is back.
   * `precise: false` asks Android for approximate only.
   */
  requestPermission(options: { level: "foreground" | "background"; precise?: boolean }): Promise<LocationStatus>;
  /** The app's page in system Settings: the only way back from `denied`, and Android 11+'s "Allow all the time". */
  openSettings(): Promise<void>;
  start(options: LocationStartOptions): Promise<LocationStatus>;
  stop(): Promise<LocationStatus>;
  /** The oldest queued entries, oldest first, and how many are queued in total. */
  pending(options?: { limit?: number }): Promise<{ entries: LocationQueueEntry[]; pending: number }>;
  /** Drop every queued entry up to and including `throughSeq` (after it is saved). */
  ack(options: { throughSeq: number }): Promise<{ pending: number }>;
  addListener(event: "sample", listener: (sample: LocationSample) => void): Promise<PluginListenerHandle>;
  addListener(event: "state", listener: (event: LocationStateEvent) => void): Promise<PluginListenerHandle>;
}

export const Location = registerPlugin<LocationPlugin>("Location");

export function nativeLocationAvailable(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.isPluginAvailable("Location");
}

/** The dev-only spike UI is compiled in only with `VITE_EXO_LOCATION_SPIKE=true`. */
export function locationSpikeEnabled(
  env: { VITE_EXO_LOCATION_SPIKE?: string } = import.meta.env,
): boolean {
  return env.VITE_EXO_LOCATION_SPIKE === "true";
}
