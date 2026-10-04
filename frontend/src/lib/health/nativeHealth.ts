// Health spike (TC-525): the native Health plugin of the Exo mobile shell.
//   Android: mobile/android/.../health/HealthPlugin.java (Health Connect)
//   iOS:     mobile/ios/App/App/HealthPlugin.swift (HealthKit; compiled into Debug builds only)
// Off by default twice over: the UI exists only in builds with VITE_EXO_HEALTH_SPIKE=true
// (`healthSpikeEnabled`), and only debug builds of the apps declare health permissions (Android) or carry
// the HealthKit entitlement and plugin (iOS). On the web and in the desktop app the plugin does not exist.
//
// The two platforms do not report the same things, and this contract does not pretend they do:
//   - Health Connect says exactly which read permissions the app holds. It does not say whether a missing
//     one was refused or never asked for, so the plugin remembers what it asked for ("denied" = asked and
//     not granted).
//   - HealthKit never says whether the app may READ a type. A denied type returns no samples, exactly like
//     a type with no data. The app only knows whether it has asked ("not_determined" vs "unknown").
// Hence `readStateKnowable`, and every null in a summary means "no data" on Android but "no data, or not
// allowed" on iOS.

import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core";

export type HealthDataType = "steps" | "sleep" | "heartRate";
export const HEALTH_DATA_TYPES: readonly HealthDataType[] = ["steps", "sleep", "heartRate"];

export type HealthPlatform = "ios" | "android";
export type HealthSource = "healthkit" | "health_connect";

export interface HealthAvailability {
  platform: HealthPlatform;
  /**
   * `needs_update`: Android 9-13 with an outdated Health Connect app (openSettings() opens Play to update it).
   * `unavailable`: no Health Connect (Android: `os_too_old`, `not_installed`) or no HealthKit (iOS:
   * `device_unsupported`, e.g. some iPads).
   */
  status: "available" | "needs_update" | "unavailable";
  reason: string | null;
  /** Android API level. */
  sdkInt?: number;
  /**
   * Whether this build can ask at all: Android debug builds declare the health permissions, release builds
   * do not; iOS needs NSHealthShareUsageDescription (and, not checkable here, the entitlement).
   */
  permissionsDeclared: boolean;
  /** Android: Health Connect's FEATURE_READ_HEALTH_DATA_IN_BACKGROUND. iOS: "unknown" (an entitlement, see enableBackgroundDelivery). */
  backgroundRead: "available" | "unavailable" | "unknown";
  /** Android: reading more than 30 days before the first grant (FEATURE_READ_HEALTH_DATA_HISTORY). iOS: always. */
  historyRead: "available" | "unavailable" | "unknown";
}

/**
 * What the app knows about reading one type:
 *  - `granted` / `denied`: Android only; `denied` = asked, not granted (refused, or revoked later).
 *  - `not_determined`: never asked, on either platform.
 *  - `unknown`: iOS after asking. HealthKit keeps the answer from the app.
 *  - `unavailable`: no Health Connect / HealthKit on this device.
 */
export type ReadAuthorization = "granted" | "denied" | "not_determined" | "unknown" | "unavailable";

export interface HealthAuthorization {
  /** false on iOS: read states are never `granted` or `denied` there. */
  readStateKnowable: boolean;
  types: Partial<Record<HealthDataType, ReadAuthorization>>;
  /** Android READ_HEALTH_DATA_IN_BACKGROUND; iOS `not_applicable` (background delivery is an entitlement). */
  background: "granted" | "denied" | "not_determined" | "unavailable" | "not_applicable";
  /** Development only: write access for insertSampleData (visible on both platforms). */
  sampleWrite: "granted" | "not_granted";
}

export interface HealthHeartRate {
  min: number;
  avg: number;
  max: number;
}

/** One local calendar day. A field is present only when its type was requested. */
export interface HealthDaySummary {
  /** YYYY-MM-DD in the device's time zone. */
  date: string;
  steps?: number | null;
  /** Asleep minutes of the night ending that day (ends 18:00 the day before to 18:00), overlaps merged. */
  sleepMinutes?: number | null;
  /** Separate asleep stretches in that night after merging overlaps. */
  sleepBlocks?: number;
  /** Beats per minute over the day. */
  heartRate?: HealthHeartRate | null;
  /** Apps (Android packages) or HealthKit sources (bundle ids) that recorded the day's data. */
  sources: string[];
}

export interface HealthDailySummaries {
  platform: HealthPlatform;
  source: HealthSource;
  timeZone: string;
  /** Epoch ms. */
  readAt: number;
  readStateKnowable: boolean;
  /** Not read: Android, not granted; iOS, never asked for (a denial on iOS just reads as null). */
  notGranted: HealthDataType[];
  /** Oldest first. */
  days: HealthDaySummary[];
}

export interface HealthChangedEvent {
  type: HealthDataType;
  at: number;
  error?: string;
}

export interface HealthPlugin {
  availability(): Promise<HealthAvailability>;
  authorizationStatus(options?: { types?: HealthDataType[] }): Promise<HealthAuthorization>;
  /** Shows the OS sheet (Health Connect's permission screen, HealthKit's Health Access sheet), then reports. */
  requestAuthorization(options?: {
    types?: HealthDataType[];
    /** Android: also ask for READ_HEALTH_DATA_IN_BACKGROUND (when Health Connect supports it). */
    background?: boolean;
    /** Development: also ask to write, for insertSampleData. */
    sampleWrite?: boolean;
  }): Promise<HealthAuthorization>;
  /** Use `readHealthDailySummaries`, which validates the result. */
  readDailySummaries(options?: { days?: number; types?: HealthDataType[] }): Promise<unknown>;
  /** Development: writes a week of sample steps, sleep and heart rate as Exo. */
  insertSampleData(): Promise<{ inserted: number }>;
  /** Android: Health Connect's page for Exo (or Play, to update it). iOS: the Health app. */
  openSettings(): Promise<void>;
  /** iOS: HKObserverQuery + background delivery. Android rejects `not_supported`. */
  enableBackgroundDelivery(options?: { types?: HealthDataType[] }): Promise<{
    enabled: HealthDataType[];
    errors: Record<string, string>;
    frequency: string;
  }>;
  addListener(event: "healthDataChanged", listener: (event: HealthChangedEvent) => void): Promise<PluginListenerHandle>;
}

export const Health = registerPlugin<HealthPlugin>("Health");

/** The spike's build flag. Off (unset) in every normal build. ConnectorsPage inlines the same check. */
export function healthSpikeEnabled(env: { VITE_EXO_HEALTH_SPIKE?: string } = import.meta.env): boolean {
  return env.VITE_EXO_HEALTH_SPIKE === "true";
}

/** The plugin exists only in the native app (and, on iOS, only in Debug builds). */
export function nativeHealthAvailable(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.isPluginAvailable("Health");
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function nullableNumber(value: unknown, field: string): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`health summary: ${field} is not a non-negative number`);
  }
  return value;
}

function heartRate(value: unknown): HealthHeartRate | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object") throw new Error("health summary: heartRate is not an object");
  const v = value as Record<string, unknown>;
  const avg = nullableNumber(v.avg, "heartRate.avg");
  if (avg === null) return null;
  return {
    min: nullableNumber(v.min, "heartRate.min") ?? avg,
    avg,
    max: nullableNumber(v.max, "heartRate.max") ?? avg,
  };
}

function isHealthDataType(value: unknown): value is HealthDataType {
  return typeof value === "string" && (HEALTH_DATA_TYPES as readonly string[]).includes(value);
}

/**
 * Validates the plugin's readDailySummaries result. Fields the request did not include stay absent; a
 * requested field Android omitted (an older shell dropping JSON nulls) becomes null.
 */
export function parseDailySummaries(raw: unknown, requested: readonly HealthDataType[] = HEALTH_DATA_TYPES): HealthDailySummaries {
  if (!raw || typeof raw !== "object") throw new Error("health summary: not an object");
  const r = raw as Record<string, unknown>;
  if (r.platform !== "ios" && r.platform !== "android") throw new Error("health summary: unknown platform");
  if (r.source !== "healthkit" && r.source !== "health_connect") throw new Error("health summary: unknown source");
  if (!Array.isArray(r.days)) throw new Error("health summary: days is not an array");
  const days = r.days.map((item, index): HealthDaySummary => {
    if (!item || typeof item !== "object") throw new Error(`health summary: day ${index} is not an object`);
    const d = item as Record<string, unknown>;
    if (typeof d.date !== "string" || !DATE.test(d.date)) throw new Error(`health summary: day ${index} has no YYYY-MM-DD date`);
    const day: HealthDaySummary = {
      date: d.date,
      sources: Array.isArray(d.sources) ? d.sources.filter((s): s is string => typeof s === "string") : [],
    };
    if (requested.includes("steps")) day.steps = nullableNumber(d.steps, "steps");
    if (requested.includes("sleep")) {
      day.sleepMinutes = nullableNumber(d.sleepMinutes, "sleepMinutes");
      day.sleepBlocks = nullableNumber(d.sleepBlocks, "sleepBlocks") ?? 0;
    }
    if (requested.includes("heartRate")) day.heartRate = heartRate(d.heartRate);
    return day;
  });
  return {
    platform: r.platform,
    source: r.source,
    timeZone: typeof r.timeZone === "string" ? r.timeZone : "UTC",
    readAt: typeof r.readAt === "number" ? r.readAt : Date.now(),
    // Android always knows; an iOS shell says so explicitly.
    readStateKnowable: typeof r.readStateKnowable === "boolean" ? r.readStateKnowable : r.platform === "android",
    notGranted: Array.isArray(r.notGranted) ? r.notGranted.filter(isHealthDataType) : [],
    days,
  };
}

export async function readHealthDailySummaries(
  options: { days?: number; types?: HealthDataType[] } = {},
  plugin: Pick<HealthPlugin, "readDailySummaries"> = Health,
): Promise<HealthDailySummaries> {
  const types = options.types ?? [...HEALTH_DATA_TYPES];
  return parseDailySummaries(await plugin.readDailySummaries({ days: options.days ?? 7, types }), types);
}

/** Plain words for a read state, true to what the platform actually reports. */
export function describeReadAuthorization(state: ReadAuthorization | undefined): string {
  switch (state) {
    case "granted":
      return "Allowed";
    case "denied":
      return "Not allowed (asked; turned off or refused)";
    case "not_determined":
      return "Not asked yet";
    case "unknown":
      return "Asked. iOS does not tell apps whether reading is allowed: a refusal looks like no data";
    case "unavailable":
      return "Not available on this device";
    default:
      return "Unknown";
  }
}

/** What a null in a summary means on this platform. */
export function describeMissing(readStateKnowable: boolean): string {
  return readStateKnowable ? "no data" : "no data, or not allowed";
}

export const HEALTH_TYPE_LABELS: Record<HealthDataType, string> = {
  steps: "Steps",
  sleep: "Sleep",
  heartRate: "Heart rate",
};
