import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { createFakeOnDeviceStt } from "./fakeOnDeviceStt";
import { onDeviceQueuePlace } from "./onDeviceQueue";
import { __setOnDeviceSttForTests, type OnDeviceSttPlugin, type OnDeviceSttStatus } from "./onDeviceStt";
import { __resetOnDeviceSttStoreForTests, downloadOnDeviceModel, onDeviceSttStore, retryOnDeviceNote } from "./onDeviceSttStore";

afterEach(() => __setOnDeviceSttForTests(createFakeOnDeviceStt().plugin));

describe("starting the on-device model download", () => {
  test("a download that starts reports nothing", async () => {
    __setOnDeviceSttForTests(createFakeOnDeviceStt().plugin);
    expect(await downloadOnDeviceModel()).toBeNull();
  });

  test("a download that cannot start is logged and handed back as the reason", async () => {
    const logged = spyOn(console, "error").mockImplementation(() => {});
    __setOnDeviceSttForTests({ downloadNow: async () => { throw new Error("no space"); } } as unknown as OnDeviceSttPlugin);
    expect(await downloadOnDeviceModel()).toBe("Could not start the download: no space");
    expect(logged).toHaveBeenCalledTimes(1);
    logged.mockRestore();
  });

  test("a retry that cannot be queued is logged and handed back as the reason", async () => {
    const logged = spyOn(console, "error").mockImplementation(() => {});
    __setOnDeviceSttForTests({ enqueue: async () => { throw new Error("tombstoned"); } } as unknown as OnDeviceSttPlugin);
    expect(await retryOnDeviceNote("n1")).toBe("Could not retry: tombstoned");
    expect(logged).toHaveBeenCalledTimes(1);
    logged.mockRestore();
  });
});

describe("the running job's percent, from the plugin's own progress event", () => {
  afterEach(() => __resetOnDeviceSttStoreForTests());

  /** iOS sends the percent only as `progress`, never as a `status`. */
  async function follow(queue: OnDeviceSttStatus["queue"]) {
    __resetOnDeviceSttStoreForTests();
    const fake = createFakeOnDeviceStt();
    const base = await fake.plugin.status();
    const callbacks = new Map<string, (event: never) => void>();
    fake.plugin.status = async () => ({ ...base, queue });
    fake.plugin.addListener = ((event: string, callback: (event: never) => void) => {
      callbacks.set(event, callback);
      return Promise.resolve({ remove: async () => {} });
    }) as typeof fake.plugin.addListener;
    __setOnDeviceSttForTests(fake.plugin);
    let notified = 0;
    const unsubscribe = onDeviceSttStore.subscribe(() => { notified += 1; });
    await onDeviceSttStore.refresh();
    notified = 0;
    return { progress: (id: string, percent: number) => callbacks.get("progress")!({ id, percent } as never), notified: () => notified, unsubscribe };
  }
  const running = (id: string, percent: number | null): OnDeviceSttStatus["queue"][number] => ({ id, state: "running", percent, error: null });

  test("a running job's percent moves the queue place the stepper reads", async () => {
    const run = await follow([running("n1", 0)]);
    expect(onDeviceQueuePlace(onDeviceSttStore.snapshot(), "n1")?.percent).toBe(0);
    run.progress("n1", 63);
    expect(onDeviceQueuePlace(onDeviceSttStore.snapshot(), "n1")?.percent).toBe(63);
    expect(run.notified()).toBe(1);
    run.unsubscribe();
  });

  test("a percent that stays in the same whole number does not notify; a new whole number does", async () => {
    const run = await follow([running("n1", null)]);
    run.progress("n1", 63.1);
    run.progress("n1", 63.6);
    run.progress("n1", 63.9);
    expect(run.notified()).toBe(1);
    run.progress("n1", 64);
    expect(run.notified()).toBe(2);
    expect(onDeviceQueuePlace(onDeviceSttStore.snapshot(), "n1")?.percent).toBe(64);
    run.unsubscribe();
  });

  test("a percent for a job that is not running, or not in the queue, is ignored", async () => {
    const run = await follow([{ id: "n2", state: "queued", percent: null, error: null }]);
    run.progress("n2", 10);
    run.progress("ghost", 10);
    expect(run.notified()).toBe(0);
    run.unsubscribe();
  });
});
