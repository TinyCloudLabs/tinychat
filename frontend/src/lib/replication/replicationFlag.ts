// Web-only local-replication flag. Default OFF.
//
// ON requires ALL of:
//   1. the product kill switch below is not engaged;
//   2. the build flag (`VITE_EXO_REPLICATION=true`) or the per-browser runtime flag
//      (`localStorage["tinychat:replication:enabled"] === "true"`) is set;
//   3. the platform is qualified: a Chromium browser on a desktop or Android web page. Tauri,
//      Capacitor, iOS (every iOS browser is WebKit), Safari and Firefox are refused, as is a
//      browser missing IndexedDB, Workers, Web Locks or WebCrypto (the replica needs all four).
// Pattern: chat/useExperimentalFeatures.ts (hard-coded kill switch + opt-in cache).
import { appPlatform, type AppPlatform } from "../platform";

/** Product kill switch. Set to false to force replication off for every build and browser. */
export const REPLICATION_AVAILABLE = true;

export const REPLICATION_RUNTIME_FLAG_KEY = "tinychat:replication:enabled";

export interface ReplicationEnv {
  platform: AppPlatform;
  userAgent: string;
  brands: readonly string[];
  maxTouchPoints: number;
  hasIndexedDb: boolean;
  hasWorker: boolean;
  hasLocks: boolean;
  hasSubtleCrypto: boolean;
}

/** Chromium UA-CH brand names; empty on browsers without userAgentData. */
function readBrands(nav: Navigator | undefined): string[] {
  if (!nav || !("userAgentData" in nav)) return [];
  const data = nav.userAgentData;
  if (!data || typeof data !== "object" || !("brands" in data) || !Array.isArray(data.brands)) return [];
  return data.brands.flatMap((entry: unknown) =>
    entry && typeof entry === "object" && "brand" in entry && typeof entry.brand === "string" ? [entry.brand] : []);
}

export function readReplicationEnv(): ReplicationEnv {
  const nav = typeof navigator === "undefined" ? undefined : navigator;
  // (userAgentData is Chromium-only and untyped in lib.dom.)
  return {
    platform: appPlatform(),
    userAgent: nav?.userAgent ?? "",
    brands: readBrands(nav),
    maxTouchPoints: nav?.maxTouchPoints ?? 0,
    hasIndexedDb: typeof indexedDB !== "undefined",
    hasWorker: typeof Worker !== "undefined",
    hasLocks: typeof nav?.locks?.request === "function",
    hasSubtleCrypto: typeof crypto !== "undefined" && typeof crypto.subtle !== "undefined",
  };
}

/** Why this environment is refused, or null when qualified. Never throws. */
export function replicationPlatformRefusal(env: ReplicationEnv): string | null {
  if (env.platform !== "web") return `unsupported-shell:${env.platform}`;
  const ua = env.userAgent;
  // iPhone/iPad/iPod, plus iPadOS 13+ which reports a Macintosh UA but has a touch screen.
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && env.maxTouchPoints > 1)) return "ios-webkit";
  if (/FxiOS|CriOS|EdgiOS/.test(ua)) return "ios-webkit";
  const chromium = env.brands.includes("Chromium") || /\b(Chrome|Chromium)\/\d/.test(ua);
  if (!chromium) return "not-chromium";
  if (/\bFirefox\//.test(ua)) return "not-chromium";
  if (!env.hasIndexedDb || !env.hasWorker || !env.hasLocks || !env.hasSubtleCrypto) return "missing-browser-api";
  return null;
}

function runtimeFlagSet(): boolean {
  try { return window.localStorage.getItem(REPLICATION_RUNTIME_FLAG_KEY) === "true"; } catch { return false; }
}

export interface ReplicationFlagInputs {
  killSwitchOpen?: boolean;
  buildFlag?: string | undefined;
  runtimeFlag?: boolean;
  env?: ReplicationEnv;
}

/** True only when the flag is on AND the platform is qualified. Default (nothing set) is false. */
export function isReplicationEnabled(inputs: ReplicationFlagInputs = {}): boolean {
  if (!(inputs.killSwitchOpen ?? REPLICATION_AVAILABLE)) return false;
  const requested = (inputs.buildFlag ?? import.meta.env.VITE_EXO_REPLICATION) === "true"
    || (inputs.runtimeFlag ?? runtimeFlagSet());
  if (!requested) return false;
  return replicationPlatformRefusal(inputs.env ?? readReplicationEnv()) === null;
}
