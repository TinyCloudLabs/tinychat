import { describe, expect, mock, test } from "bun:test";
import type { ReactElement, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { StaticRecorderProvider } from "../RecorderProvider";
import { PlatformContext } from "@/lib/platform";
import {
  isPhoneRecorderPreloadError,
  LazyPhoneRecorder,
  LoadFailed,
  Surface,
} from "./LazyPhoneRecorder";

describe("LazyPhoneRecorder", () => {
  test("shows an Opening recorder… status while the recorder's chunk is fetched", () => {
    const html = renderToStaticMarkup(
      <StaticRecorderProvider value={{ phase: "recording" }}>
        <LazyPhoneRecorder load={() => new Promise(() => {})} />
      </StaticRecorderProvider>,
    );
    expect(html).toContain('role="status"');
    expect(html).toContain("Opening recorder…");
  });

  test("a chunk that cannot be fetched is a visible alert that says the recording continues", () => {
    const html = renderToStaticMarkup(
      <StaticRecorderProvider value={{ phase: "recording" }}>
        <LoadFailed onRetry={() => {}} />
      </StaticRecorderProvider>,
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain("Couldn&#x27;t open the recorder.");
    expect(html).toContain("Your recording continues.");
    expect(html).toContain("Try again");
  });

  test("only a failure of the phone recorder's own chunk counts as the recorder failing to open", () => {
    const event = (message: string) =>
      Object.assign(new Event("vite:preloadError"), { payload: new Error(message) });
    expect(
      isPhoneRecorderPreloadError(
        event("Unable to preload CSS for /assets/PhoneRecorder-1a2b.css"),
      ),
    ).toBe(true);
    expect(
      isPhoneRecorderPreloadError(
        event("Unable to preload CSS for /assets/NotesRenderer-9f9f.css"),
      ),
    ).toBe(false);
    expect(isPhoneRecorderPreloadError(new Event("vite:preloadError"))).toBe(false);
  });

  test("Reload Exo on the web asks first while a recording runs, because the reload would stop it", () => {
    const html = renderToStaticMarkup(
      <PlatformContext.Provider value="web">
        <StaticRecorderProvider value={{ phase: "recording" }}>
          <LoadFailed label="Reload Exo" onRetry={() => {}} defaultConfirming />
        </StaticRecorderProvider>
      </PlatformContext.Provider>,
    );
    expect(html).toContain("Reloading stops this recording in the browser.");
    expect(html).toContain("Keep recording");
    const phone = renderToStaticMarkup(
      <PlatformContext.Provider value="ios">
        <StaticRecorderProvider value={{ phase: "recording" }}>
          <LoadFailed label="Reload Exo" onRetry={() => {}} defaultConfirming />
        </StaticRecorderProvider>
      </PlatformContext.Provider>,
    );
    expect(phone).not.toContain("Reloading stops");
  });

  test("the loading and failed surfaces both offer Minimise recorder", () => {
    const pending = renderToStaticMarkup(
      <StaticRecorderProvider value={{ phase: "recording" }}>
        <LazyPhoneRecorder load={() => new Promise(() => {})} />
      </StaticRecorderProvider>,
    );
    const failed = renderToStaticMarkup(
      <StaticRecorderProvider value={{ phase: "recording" }}>
        <LoadFailed label="Reload Exo" onRetry={() => {}} />
      </StaticRecorderProvider>,
    );
    for (const html of [pending, failed])
      expect(html).toContain('aria-label="Minimise recorder"');
  });

  test("pressing Minimise recorder on either surface minimises the sheet", () => {
    for (const surface of ["pending", "failed"] as const) {
      const minimiseSheet = mock(() => {});
      let tree: ReactElement<{ onMinimise: () => void }> | null = null;
      function Probe() {
        // Surface is what both the pending and the failed states draw; the failed state's own children sit inside it.
        const child: ReactNode =
          surface === "pending" ? <p>Opening recorder…</p> : <p>Couldn't open the recorder.</p>;
        tree = Surface({ children: child }) as typeof tree;
        return null;
      }
      renderToStaticMarkup(
        <StaticRecorderProvider value={{ phase: "recording", minimiseSheet }}>
          <Probe />
        </StaticRecorderProvider>,
      );
      if (tree === null) throw new Error("no surface");
      (tree as ReactElement<{ onMinimise: () => void }>).props.onMinimise();
      expect(minimiseSheet).toHaveBeenCalledTimes(1);
    }
  });
});
