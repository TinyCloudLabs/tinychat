import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { installDom } from "@/test/dom";
import { installStatusTapScroll, scrollToTopOnStatusTap, STATUS_TAP_EVENT } from "./statusTapScroll";

let restore: (() => void) | undefined;
beforeEach(() => {
  restore = installDom();
});
afterEach(() => {
  restore?.();
  restore = undefined;
});

/** The phone shell: a fixed-height box whose screen scrolls inside its own element, the document never scrolls. */
function mountShell(): { screen: HTMLElement; list: HTMLElement; row: HTMLElement } {
  document.body.innerHTML = `
    <div id="root" style="height:100%">
      <main id="screen" style="height:100%;overflow-y:auto">
        <ul id="list" style="max-height:200px;overflow-y:auto"><li id="row">row</li></ul>
      </main>
    </div>`;
  return {
    screen: document.getElementById("screen")!,
    list: document.getElementById("list")!,
    row: document.getElementById("row")!,
  };
}

/** Records the scrollTo calls an element receives and applies them, as a browser's finished scroll would. */
function recordScrollTo(element: HTMLElement): ScrollToOptions[] {
  const calls: ScrollToOptions[] = [];
  element.scrollTo = ((options: ScrollToOptions) => {
    calls.push(options);
    element.scrollTop = options.top ?? 0;
  }) as typeof element.scrollTo;
  return calls;
}

describe("status-bar tap in the phone shell", () => {
  test("scrolls the screen's own scroller back to the top while the document stays put", () => {
    const { screen, row } = mountShell();
    screen.scrollTop = 900;
    const calls = recordScrollTo(screen);

    const scrolled = scrollToTopOnStatusTap(window as unknown as Window, () => row);

    expect(scrolled).toBe(screen);
    expect(calls).toEqual([{ top: 0, behavior: "smooth" }]);
    expect(screen.scrollTop).toBe(0);
  });

  test("a scrolled list inside a scrolled screen takes the screen first, as the outer scroller", () => {
    const { screen, list, row } = mountShell();
    screen.scrollTop = 500;
    list.scrollTop = 40;
    const screenCalls = recordScrollTo(screen);
    const listCalls = recordScrollTo(list);

    expect(scrollToTopOnStatusTap(window as unknown as Window, () => row)).toBe(screen);
    expect(screenCalls).toHaveLength(1);
    expect(listCalls).toHaveLength(0);
  });

  test("a screen already at the top is left alone, even when a list inside it was scrolled by hand", () => {
    const { screen, list, row } = mountShell();
    list.scrollTop = 40;
    const screenCalls = recordScrollTo(screen);
    const listCalls = recordScrollTo(list);

    expect(scrollToTopOnStatusTap(window as unknown as Window, () => row)).toBe(list);
    expect(screenCalls).toHaveLength(0);
    expect(listCalls).toEqual([{ top: 0, behavior: "smooth" }]);
  });

  test("does nothing when nothing under the middle of the screen is scrolled down", () => {
    const { screen, row } = mountShell();
    const calls = recordScrollTo(screen);

    expect(scrollToTopOnStatusTap(window as unknown as Window, () => row)).toBeNull();
    expect(scrollToTopOnStatusTap(window as unknown as Window, () => null)).toBeNull();
    expect(calls).toHaveLength(0);
  });

  test("a scrolled element that is not a scroller (overflow visible) is not scrolled", () => {
    document.body.innerHTML = `<div id="box" style="overflow-y:visible"><span id="leaf">x</span></div>`;
    const box = document.getElementById("box")!;
    box.scrollTop = 30;
    const calls = recordScrollTo(box);

    expect(scrollToTopOnStatusTap(window as unknown as Window, () => document.getElementById("leaf"))).toBeNull();
    expect(calls).toHaveLength(0);
  });

  test("scrolls the document when the page itself is the scroller", () => {
    const { row } = mountShell();
    const page = document.scrollingElement as HTMLElement;
    page.scrollTop = 700;
    const calls = recordScrollTo(page);

    expect(scrollToTopOnStatusTap(window as unknown as Window, () => row)).toBe(page);
    expect(calls).toEqual([{ top: 0, behavior: "smooth" }]);
  });

  test("the native statusTap window event runs it, and stopping the listener ends that", () => {
    const { screen } = mountShell();
    screen.scrollTop = 900;
    const calls = recordScrollTo(screen);
    // happy-dom has no layout, so hit-testing the screen's middle finds nothing; the event path is covered by stubbing it.
    const doc = document as unknown as { elementFromPoint: (x: number, y: number) => Element | null };
    doc.elementFromPoint = () => screen;

    const stop = installStatusTapScroll(window as unknown as Window);
    window.dispatchEvent(new Event(STATUS_TAP_EVENT));
    expect(calls).toHaveLength(1);

    screen.scrollTop = 900;
    stop();
    window.dispatchEvent(new Event(STATUS_TAP_EVENT));
    expect(calls).toHaveLength(1);
  });
});
