// Which destinations a user has pinned to the navigation (One Apps).
//
// Feed, Chat and Apps are always there; they are not pins. Everything else that
// can sit in the nav is a pin: the native Recording and Connectors destinations
// and the TinyCloud apps. Pins are kept per account in localStorage, in pin
// order, and anything this build does not know is dropped on read.
import { useCallback, useMemo, useSyncExternalStore } from "react";

/** One Apps is on only when the build says exactly "true". Off means today's navigation and Apps page. */
export const ONE_APPS_ENABLED = import.meta.env.VITE_ONE_APPS === "true";
/**
 * One's new navigation over One Apps (TC-3650): the phone's floating pill, Feed, Chat and Apps plus You, the Apps grid
 * with Add an app, and the open app's bar on every app screen. Only with One Apps on and the build saying exactly
 * "true"; off is One Apps as it was.
 */
export const ONE_NAV_ENABLED = ONE_APPS_ENABLED && import.meta.env.VITE_ONE_NAV === "true";

export type NativePinId = "capture" | "connectors";
export type AppPinId = `app:${string}`;
export type PinId = NativePinId | AppPinId;

export const NATIVE_PIN_IDS: readonly NativePinId[] = ["capture", "connectors"];

const APP_PREFIX = "app:";

export const appPinId = (appId: string): AppPinId => `${APP_PREFIX}${appId}`;

/** The app id inside an app pin, else null. */
export function appIdOfPin(id: string): string | null {
  return id.startsWith(APP_PREFIX) && id.length > APP_PREFIX.length ? id.slice(APP_PREFIX.length) : null;
}

/** The pins in a stored value: known ids only, each once, in stored order. Never throws. */
export function parsePins(raw: string | null, knownAppIds: readonly string[]): PinId[] {
  if (raw === null) return [];
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(value)) return [];
  const pins: PinId[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || pins.includes(entry as PinId)) continue;
    const appId = appIdOfPin(entry);
    const known = appId === null ? (NATIVE_PIN_IDS as readonly string[]).includes(entry) : knownAppIds.includes(appId);
    if (known) pins.push(entry as PinId);
  }
  return pins;
}

/** The storage key for one account: pins never cross accounts on a shared browser. */
export const navPinsKey = (did: string) => `tinycloud.one.navPins.v1:${did}`;

const listeners = new Set<() => void>();

function storageOrNull(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function readRaw(did: string | null): string | null {
  if (did === null) return null;
  try {
    return storageOrNull()?.getItem(navPinsKey(did)) ?? null;
  } catch {
    return null;
  }
}

function writePins(did: string, pins: readonly PinId[]): void {
  try {
    storageOrNull()?.setItem(navPinsKey(did), JSON.stringify(pins));
  } catch {
    /* A full or blocked store leaves the pins as they were. */
  }
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key.startsWith("tinycloud.one.navPins.v1:")) listener();
  };
  globalThis.addEventListener?.("storage", onStorage);
  return () => {
    listeners.delete(listener);
    globalThis.removeEventListener?.("storage", onStorage);
  };
}

/** Adds a pin after the others. Defaults and unknown ids are not pinnable; pinning twice is one pin. */
export function pinDestination(did: string, id: PinId, knownAppIds: readonly string[]): void {
  const pins = parsePins(readRaw(did), knownAppIds);
  const next = parsePins(JSON.stringify([...pins, id]), knownAppIds);
  if (next.length !== pins.length) writePins(did, next);
}

/** Removes a pin. Feed, Chat and Apps are not pins, so there is nothing to remove. */
export function unpinDestination(did: string, id: PinId, knownAppIds: readonly string[]): void {
  const pins = parsePins(readRaw(did), knownAppIds);
  if (pins.includes(id)) writePins(did, pins.filter((pin) => pin !== id));
}

export interface NavPins {
  /** Pins in pin order; empty while signed out. */
  pins: readonly PinId[];
  pin: (id: PinId) => void;
  unpin: (id: PinId) => void;
}

/** The signed-in account's pins, live across the shell, the launcher and other tabs. `knownAppIds` must be a stable array. */
export function useNavPins(did: string | null, knownAppIds: readonly string[]): NavPins {
  const raw = useSyncExternalStore(subscribe, () => readRaw(did), () => null);
  const pins = useMemo(() => parsePins(raw, knownAppIds), [raw, knownAppIds]);
  const pin = useCallback((id: PinId) => { if (did !== null) pinDestination(did, id, knownAppIds); }, [did, knownAppIds]);
  const unpin = useCallback((id: PinId) => { if (did !== null) unpinDestination(did, id, knownAppIds); }, [did, knownAppIds]);
  return { pins, pin, unpin };
}
