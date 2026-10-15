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
