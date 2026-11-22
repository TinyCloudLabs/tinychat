// The phone's Apps grid re-sorts when an app is pinned or unpinned (pinned apps first), so the tap that ends a long
// press lands on whichever tile has moved under the finger. That tap must open nothing (TC-3650).
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router-dom";

import { installDom } from "@/test/dom";
import { oneAppsFor } from "@/apps/registry";
import type { PinId } from "@/shell/navPins";
import { AppsGrid, LONG_PRESS_MS } from "./AppsGrid";
import { gridTiles, pinnedFirst } from "./AppsPage";

const restoreDom = installDom();
afterAll(restoreDom);

const TILES = gridTiles(0, oneAppsFor("web", true));

function PhoneGrid({ calls }: { calls: string[] }) {
  const [pins, setPins] = useState<PinId[]>([]);
  return (
    <>
      <AppsGrid
        tiles={pinnedFirst(TILES, pins)}
        pins={pins}
        canPin
        onPin={(pin) => { calls.push(`pin ${pin}`); setPins((current) => [...current, pin]); }}
        onUnpin={(pin) => { calls.push(`unpin ${pin}`); setPins((current) => current.filter((entry) => entry !== pin)); }}
        addApp={false}
      />
      <Where />
    </>
  );
}

function Where() {
  return <output data-testid="where">{useLocation().pathname}</output>;
}

describe("long press on the phone's re-sorting grid", () => {
  let host: HTMLDivElement;
  let root: Root;
  const calls: string[] = [];
  beforeEach(() => {
    calls.length = 0;
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    act(() => root.render(<MemoryRouter><PhoneGrid calls={calls} /></MemoryRouter>));
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  const tiles = () => [...host.querySelectorAll("ul a")];
  const where = () => host.querySelector('[data-testid="where"]')!.textContent;
  const touch = (type: string, target: Element) =>
    target.dispatchEvent(new window.PointerEvent(type, { bubbles: true, pointerType: "touch", clientX: 10, clientY: 10 }) as unknown as Event);
  /**
   * A touch held on the tile at `slot`, released, then the tap the browser sends to whatever tile sits at `slot` by then.
   * Returns where One is afterwards.
   */
  const pressAt = async (slot: number, holdMs: number) => {
    const pressed = tiles()[slot]!;
    await act(async () => {
      touch("pointerdown", pressed);
      await Bun.sleep(holdMs);
      touch("pointerup", pressed);
    });
    await act(async () => {
      tiles()[slot]!.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }) as unknown as Event);
    });
    return where();
  };

  test("pinning the last tile moves it first, and the tap that ends the press opens no other app", async () => {
    const last = TILES.length - 1;
    expect(await pressAt(last, LONG_PRESS_MS + 80)).toBe("/");
    expect(calls).toEqual([`pin ${TILES[last]!.pin}`]);
    expect(tiles()[0]!.hasAttribute("data-pinned")).toBe(true);
  });

  test("unpinning the first tile moves it back, and the tap that ends the press opens no other app", async () => {
    const last = TILES.length - 1;
    await pressAt(last, LONG_PRESS_MS + 80);
    expect(await pressAt(0, LONG_PRESS_MS + 80)).toBe("/");
    expect(calls).toEqual([`pin ${TILES[last]!.pin}`, `unpin ${TILES[last]!.pin}`]);
    expect(tiles().some((tile) => tile.hasAttribute("data-pinned"))).toBe(false);
  });

  test("after a long press, the next short tap opens its app", async () => {
    const last = TILES.length - 1;
    await pressAt(last, LONG_PRESS_MS + 80);
    expect(await pressAt(1, 60)).toBe(TILES[0]!.path);
    expect(calls).toEqual([`pin ${TILES[last]!.pin}`]);
  });
});
