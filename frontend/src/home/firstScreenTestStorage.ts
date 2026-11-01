/** Test-only fake `localStorage`; `throwing` makes every access throw. */
export function installFakeLocalStorage({ throwing = false }: { throwing?: boolean } = {}) {
  const values = new Map<string, string>();
  const fail = () => { throw new Error("storage unavailable"); };
  const fake = {
    getItem: (key: string) => (throwing ? fail() : values.get(key) ?? null),
    setItem: (key: string, value: string) => { if (throwing) fail(); values.set(key, String(value)); },
    removeItem: (key: string) => { if (throwing) fail(); values.delete(key); },
  };
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, writable: true, value: fake });
  return {
    values,
    uninstall() {
      if (previous) Object.defineProperty(globalThis, "localStorage", previous);
      else Reflect.deleteProperty(globalThis, "localStorage");
    },
  };
}
