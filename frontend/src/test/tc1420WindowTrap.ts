// TC-1420 diagnostic (CI only, removed once the writer is fixed).
// Records the last assignments to `globalThis.window` that lack `location`, with the
// nearest test-source frames; `reportWindowShape` dumps the ring when it warns.
// Transparent to callers: while a value is stored, Object and Reflect
// getOwnPropertyDescriptor report `window` as a data property; a defineProperty with a
// value stores it; deleteProperty removes it and reports absent.
// Known gaps: `"window" in globalThis` is true while absent; a plain assignment after
// deletion creates an untracked data property until the next defineProperty.

const RING_KEY = Symbol.for("tc1420.ring");
const RING_SIZE = 20;

interface TrapEntry {
  tag: string;
  keys: string;
  location: string;
  frames: string[];
}

interface Attributes {
  writable: boolean;
  enumerable: boolean;
  configurable: boolean;
}

function hasLocation(value: unknown): boolean {
  return typeof value === "object" && value !== null && typeof Reflect.get(value, "location") === "object";
}

function describeValue(value: unknown): { keys: string; location: string } {
  if (typeof value !== "object" || value === null) return { keys: String(value), location: "n/a" };
  const names = Object.getOwnPropertyNames(value).sort();
  const location = Reflect.get(value, "location");
  return {
    keys: `${names.length} keys [${names.slice(0, 12).join(",")}]`,
    location: typeof location,
  };
}

function testFrames(): string[] {
  const out: string[] = [];
  for (const line of (new Error().stack ?? "").split("\n").filter((text) => !text.includes("tc1420WindowTrap"))) {
    const match = /(frontend\/src\/(?:test\/|[^\s):]*\.test\.)[^\s):]*:\d+)/.exec(line);
    if (match) out.push(match[1]);
    if (out.length === 8) break;
  }
  return out;
}

if (process.env.CI === "true" && !Reflect.get(globalThis, RING_KEY)) {
  const ring: TrapEntry[] = [];
  Reflect.set(globalThis, RING_KEY, ring);

  const originalDefine = Object.defineProperty;
  const originalObjectGetOwn = Object.getOwnPropertyDescriptor;
  const originalReflectGetOwn = Reflect.getOwnPropertyDescriptor;
  const originalDelete = Reflect.deleteProperty;

  let stored: unknown = undefined;
  let present = false;
  let attrs: Attributes = { writable: true, enumerable: false, configurable: true };

  const record = (tag: string, value: unknown) => {
    const { keys, location } = describeValue(value);
    ring.push({ tag, keys, location, frames: testFrames() });
    if (ring.length > RING_SIZE) ring.shift();
  };

  const getter = () => stored;
  const setter = (value: unknown) => {
    if (!hasLocation(value)) record("set-no-location", value);
    else if (!hasLocation(stored)) record("set-with-location(after-no-location)", value);
    stored = value;
    present = true;
  };
  const accessor: PropertyDescriptor = {
    configurable: true,
    enumerable: attrs.enumerable,
    get: getter,
    set: setter,
  };
  const isTrapAccessor = (descriptor: PropertyDescriptor | undefined) =>
    descriptor !== undefined && descriptor.get === getter;
  const reported = (descriptor: PropertyDescriptor | undefined): PropertyDescriptor | undefined => {
    if (!isTrapAccessor(descriptor)) return descriptor;
    if (!present) return undefined;
    return {
      value: stored,
      writable: attrs.writable,
      enumerable: attrs.enumerable,
      configurable: attrs.configurable,
    };
  };

  Object.getOwnPropertyDescriptor = (target: object, key: PropertyKey) => {
    const descriptor = originalObjectGetOwn(target, key);
    return target === globalThis && key === "window" ? reported(descriptor) : descriptor;
  };
  Reflect.getOwnPropertyDescriptor = (target: object, key: PropertyKey) => {
    const descriptor = originalReflectGetOwn(target, key);
    return target === globalThis && key === "window" ? reported(descriptor) : descriptor;
  };

  Reflect.deleteProperty = (target: object, key: PropertyKey) => {
    if (target === globalThis && key === "window") {
      record("deleteProperty", stored);
      stored = undefined;
      present = false;
    }
    return originalDelete(target, key);
  };

  Object.defineProperty = <T>(target: T, key: PropertyKey, descriptor: PropertyDescriptor & ThisType<any>): T => {
    if (target !== globalThis || key !== "window" || !("value" in descriptor)) {
      return originalDefine(target, key, descriptor);
    }
    const value: unknown = descriptor.value;
    if (!hasLocation(value)) record("defineProperty-no-location", value);
    else if (!hasLocation(stored)) record("defineProperty-with-location(after-no-location)", value);
    stored = value;
    present = true;
    attrs = {
      writable: descriptor.writable ?? false,
      enumerable: descriptor.enumerable ?? false,
      configurable: descriptor.configurable ?? false,
    };
    originalDefine(target, key, { ...accessor, enumerable: attrs.enumerable });
    return target;
  };

  originalDefine(globalThis, "window", accessor);
}

export {};
