// Import this FIRST in a test that renders dialogs or types into inputs: react-dom checks at import time
// whether a DOM exists, so the DOM has to be installed before react-dom is loaded.
// happy-dom is not seen as supporting the `input` event, so React reads typed text on keyup: type with
// `setValue` below.
import { installDom } from "./dom";

export const restoreDomBeforeReact = installDom();

/** Sets an input's text the way React sees it in happy-dom: the native setter, then a keyup. */
export async function setValue(input: HTMLInputElement, value: string, act: (callback: () => Promise<void> | void) => Promise<void>): Promise<void> {
  input.focus();
  Object.getOwnPropertyDescriptor(input.constructor.prototype, "value")?.set?.call(input, value);
  await act(() => { input.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true })); });
}
