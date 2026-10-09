import { describe, expect, test } from "bun:test";

import { createBrowserAudioInputs, toAudioInputs, type BrowserAudioInputsDeps } from "./browserAudioInputs";

const device = (deviceId: string, label: string, kind: MediaDeviceKind = "audioinput") =>
  ({ deviceId, label, kind, groupId: "g", toJSON: () => ({}) }) as MediaDeviceInfo;

function setup(initial: MediaDeviceInfo[]) {
  let devices = initial;
  const events = new EventTarget();
  const selected: Array<string | null> = [];
  const deps: BrowserAudioInputsDeps = {
    mediaDevices: () => ({
      enumerateDevices: async () => devices,
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
    }),
    selectInput: async (id) => void selected.push(id),
  };
  return {
    source: createBrowserAudioInputs(deps),
    selected,
    plug(next: MediaDeviceInfo[]) {
      devices = next;
      events.dispatchEvent(new Event("devicechange"));
    },
  };
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 5));

describe("toAudioInputs", () => {
  test("keeps microphones only, drops the 'communications' alias, and numbers the ones without a label yet", () => {
    expect(
      toAudioInputs([
        device("default", ""),
        device("communications", ""),
        device("cam", "Camera", "videoinput"),
        device("spk", "Speakers", "audiooutput"),
        device("usb-1", ""),
      ]),
    ).toEqual([
      { id: "default", name: "Microphone 1", kind: "other" },
      { id: "usb-1", name: "Microphone 2", kind: "other" },
    ]);
  });

  test("labels appear after permission, with an icon kind where the label says so", () => {
    expect(
      toAudioInputs([
        device("a", "MacBook Pro Microphone"),
        device("b", "AirPods Pro"),
        device("c", "USB Audio Device"),
        device("d", "Yeti"),
      ]).map((input) => [input.name, input.kind]),
    ).toEqual([
      ["MacBook Pro Microphone", "built_in"],
      ["AirPods Pro", "bluetooth"],
      ["USB Audio Device", "usb"],
      ["Yeti", "other"],
    ]);
  });
});

describe("createBrowserAudioInputs", () => {
  test("lists through enumerateDevices", async () => {
    const { source } = setup([device("a", "Mic A"), device("b", "Mic B")]);
    expect(await source.list()).toEqual({
      inputs: [
        { id: "a", name: "Mic A", kind: "other" },
        { id: "b", name: "Mic B", kind: "other" },
      ],
      selectedId: null,
      activeId: null,
    });
  });

  test("a choice goes to the engine, then shows as selected", async () => {
    const { source, selected } = setup([device("a", "Mic A"), device("b", "Mic B")]);
    await source.select("b");
    expect(selected).toEqual(["b"]);
    expect((await source.list()).selectedId).toBe("b");
  });

  test("a choice is published to subscribers, so the list does not wait for a device event", async () => {
    const { source } = setup([device("a", "Mic A"), device("b", "Mic B")]);
    const seen: Array<string | null> = [];
    const unsubscribe = source.subscribe((snapshot) => seen.push(snapshot.selectedId));
    await source.select("b");
    await flush();
    expect(seen).toEqual(["b"]);
    unsubscribe();
    await source.select("a");
    await flush();
    expect(seen).toEqual(["b"]);
  });

  test("a choice the engine refuses is not recorded as selected, and the refusal reaches the caller", async () => {
    const refused = Object.assign(new Error("unsupported"), { code: "unsupported" });
    const source = createBrowserAudioInputs({
      mediaDevices: () => ({ enumerateDevices: async () => [device("a", "Mic A")], addEventListener() {}, removeEventListener() {} }),
      selectInput: () => Promise.reject(refused),
    });
    const seen: unknown[] = [];
    source.subscribe((snapshot) => seen.push(snapshot));
    await expect(source.select("a")).rejects.toBe(refused);
    await flush();
    expect(seen).toEqual([]);
    expect((await source.list()).selectedId).toBeNull();
  });

  test("follows devicechange until unsubscribed, and a selected microphone that is unplugged is no longer selected", async () => {
    const { source, plug } = setup([device("a", "Mic A"), device("b", "Mic B")]);
    await source.select("b");
    const seen: string[][] = [];
    const unsubscribe = source.subscribe((snapshot) => seen.push(snapshot.inputs.map((input) => input.id)));
    plug([device("a", "Mic A"), device("b", "Mic B"), device("c", "Mic C")]);
    await flush();
    plug([device("a", "Mic A")]);
    await flush();
    expect(seen).toEqual([["a", "b", "c"], ["a"]]);
    expect((await source.list()).selectedId).toBeNull();
    unsubscribe();
    plug([device("z", "Mic Z")]);
    await flush();
    expect(seen).toHaveLength(2);
  });

  test("a failed enumerate on devicechange reaches onError", async () => {
    const boom = new Error("denied by policy");
    const events = new EventTarget();
    const source = createBrowserAudioInputs({
      mediaDevices: () => ({
        enumerateDevices: () => Promise.reject(boom),
        addEventListener: events.addEventListener.bind(events),
        removeEventListener: events.removeEventListener.bind(events),
      }),
      selectInput: async () => {},
    });
    const errors: unknown[] = [];
    source.subscribe(() => {}, (caught) => errors.push(caught));
    events.dispatchEvent(new Event("devicechange"));
    await flush();
    expect(errors).toEqual([boom]);
  });
});
