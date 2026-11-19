/**
 * The web SDK decides first-party from `window.location.origin` (js-sdk #945): an unregistered owner may sign in only
 * on TinyCloud's own origins. Real-SDK tests that sign in therefore run at the product's origin, not happy-dom's
 * default http://localhost. Call after installDom().
 */
export const PRODUCT_ORIGIN = "https://tinycloud.chat";

type HappyDomWindow = { happyDOM: { setURL(url: string): void }; location: Location };

/** Puts the installed DOM at `origin` + `path`. For a scheme happy-dom reports as "null" (a native app's custom
 * scheme), `location.origin` is set to `origin` as the WebView reports it. */
export function atOrigin(origin: string = PRODUCT_ORIGIN, path = "/chat"): void {
  const dom = window as unknown as HappyDomWindow;
  dom.happyDOM.setURL(`${origin}${path}`);
  if (dom.location.origin !== origin) {
    Object.defineProperty(dom.location, "origin", { configurable: true, get: () => origin });
  }
}
