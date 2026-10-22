// @tinyboilerplate/client evaluates the TinyCloud web-sdk at module load, and the
// SDK reads these DOM globals then. Tests that import it without a DOM stub them
// first. Only undefined names are filled, so an installed DOM is never replaced.
// The returned restore puts back each name's exact prior own-property descriptor
// and deletes names that were absent, so no stub outlives the caller.

const SDK_DOM_GLOBALS = ["window", "HTMLElement", "customElements"] as const;

export function stubSdkDomGlobals(): () => void {
  const target = globalThis as unknown as Record<string, unknown>;
  const before = new Map<string, PropertyDescriptor | undefined>();
  for (const name of SDK_DOM_GLOBALS) {
    before.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  }
  if (typeof target.HTMLElement === "undefined") target.HTMLElement = class {};
  if (typeof target.customElements === "undefined") {
    target.customElements = { define() {}, get() {} };
  }
  if (typeof target.window === "undefined") target.window = target;
  return () => {
    for (const [name, descriptor] of before) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  };
}
