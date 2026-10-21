import { Window } from "happy-dom";

/** Installs an isolated browser DOM for interaction tests that mount React. */
export function installDom() {
  const dom = new Window({ url: "http://localhost/chat/capture" });
  Object.assign(dom, { TypeError, Error });
  const target = globalThis as typeof globalThis & Record<string, unknown>;
  const names = ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "Element", "Node", "NodeFilter", "KeyboardEvent", "CompositionEvent", "Event", "CustomEvent", "FocusEvent", "InputEvent", "MouseEvent", "PointerEvent", "MutationObserver", "customElements", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"] as const;
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const name of names) {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(target, name, { configurable: true, writable: true, value: name === "window" ? dom : name === "document" ? dom.document : name === "navigator" ? dom.navigator : name in dom ? (dom as unknown as Record<string, unknown>)[name] : (dom.window as unknown as Record<string, unknown>)[name] });
  }
  Object.defineProperty(target, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, writable: true, value: true });
  return () => {
    dom.happyDOM.abort();
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(target, name, descriptor);
      else Reflect.deleteProperty(target, name);
    }
    Reflect.deleteProperty(target, "IS_REACT_ACT_ENVIRONMENT");
  };
}

/** Reports the shape (own keys only, no values) of an unexpected global `window` lacking `location`. */
export function reportWindowShape(where: string): void {
  const current: unknown = Reflect.get(globalThis, "window");
  const isObject = typeof current === "object" && current !== null;
  if (!isObject || (isObject && "location" in current && typeof current.location !== "undefined")) return;
  const keys = isObject ? `{${Object.getOwnPropertyNames(current).sort().join(",")}}` : String(current);
  const location = isObject && "location" in current ? typeof current.location : "missing";
  console.warn(`[TC-1420] ${where}: unexpected global window ${keys}, window.location=${location}`);
}
