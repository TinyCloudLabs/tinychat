// TC-1420 diagnostic (CI only, removed once the writer is fixed).
// Keeps a ring of the last assignments to `globalThis.window` that lack `location`,
// with the nearest test-source frames. `reportWindowShape` dumps the ring when it warns.
// Test behaviour is unchanged: values are stored and returned as assigned.

const RING_KEY = Symbol.for("tc1420.ring");
const RING_SIZE = 20;

interface TrapEntry {
  tag: string;
  keys: string;
  location: string;
  frames: string[];
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
  let stored: unknown = Reflect.get(globalThis, "window");

  const record = (tag: string, value: unknown) => {
    const { keys, location } = describeValue(value);
    ring.push({ tag, keys, location, frames: testFrames() });
    if (ring.length > RING_SIZE) ring.shift();
  };

  const accessor: PropertyDescriptor = {
    configurable: true,
    enumerable: true,
    get: () => stored,
    set: (value: unknown) => {
      if (!hasLocation(value)) record("set-no-location", value);
      else if (!hasLocation(stored)) record("set-with-location(after-no-location)", value);
      stored = value;
    },
  };

  const originalDefine = Object.defineProperty;
  const trapped: typeof Object.defineProperty = (target, key, descriptor) => {
    if (target !== globalThis || key !== "window" || !("value" in descriptor)) {
      return originalDefine(target, key, descriptor);
    }
    const value: unknown = descriptor.value;
    if (!hasLocation(value)) record("defineProperty-no-location", value);
    else if (!hasLocation(stored)) record("defineProperty-with-location(after-no-location)", value);
    stored = value;
    originalDefine(target, key, accessor);
    return target;
  };
  Object.defineProperty = trapped;

  originalDefine(globalThis, "window", accessor);
}

export {};
