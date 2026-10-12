import { afterEach, describe, expect, test } from "bun:test";
import { installDom } from "@/test/dom";
import { registerPlayback, stopAllPlayback } from "./playback";

let cleanup: (() => void) | undefined;
afterEach(() => { cleanup?.(); cleanup = undefined; });

describe("playback registry", () => {
  test("stops every registered player and unregisters on unmount", () => {
    cleanup = installDom();
    const first = document.createElement("audio");
    const second = document.createElement("audio");
    document.body.append(first, second);
    let a = 0, b = 0;
    const unregisterFirst = registerPlayback(first, () => { a++; });
    const unregisterSecond = registerPlayback(second, () => { b++; });
    stopAllPlayback();
    expect([a, b]).toEqual([1, 1]);
    unregisterFirst();
    stopAllPlayback();
    expect([a, b]).toEqual([2, 2]);
    unregisterSecond();
  });

  test("a hidden pane, a covering dialog and a closed player stop playback", async () => {
    cleanup = installDom();
    const pane = document.createElement("div");
    const audio = document.createElement("audio");
    pane.append(audio);
    document.body.append(pane);
    let stops = 0;
    const unregister = registerPlayback(audio, () => { stops++; });
    pane.classList.add("hidden");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(stops).toBeGreaterThan(0);
    pane.classList.remove("hidden");
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.dataset.state = "open";
    document.body.append(dialog);
    const beforeCover = stops;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(stops).toBeGreaterThan(beforeCover);
    dialog.remove();
    const recorderHost = document.createElement("div");
    recorderHost.setAttribute("data-recorder-host", "");
    recorderHost.append(document.createElement("div"));
    document.body.append(recorderHost);
    const beforeRecorder = stops;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(stops).toBeGreaterThan(beforeRecorder);
    recorderHost.remove();
    unregister();
    expect(stops).toBeGreaterThan(beforeCover + 1);
  });
});
