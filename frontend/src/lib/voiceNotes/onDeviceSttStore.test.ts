import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { localModelGuide } from "@/capture/recorder/final/localModelGuide";
import { createFakeOnDeviceStt, type FakeOnDeviceStt } from "./fakeOnDeviceStt";
import { onDeviceQueuePlace } from "./onDeviceQueue";
import { __setOnDeviceSttForTests, isOnDeviceReady, type OnDeviceSttPlugin, type OnDeviceSttStatus } from "./onDeviceStt";
import { __resetOnDeviceSttStoreForTests, downloadOnDeviceModel, ensureOnDeviceModel, onDeviceSttStore, retryOnDeviceNote } from "./onDeviceSttStore";

afterEach(() => {
  __setOnDeviceSttForTests(createFakeOnDeviceStt().plugin);
  __resetOnDeviceSttStoreForTests();
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** The native `downloadNow`: one promise that settles when the download ends, and the models land in the status. */
function downloading(fake: FakeOnDeviceStt) {
  const calls = { downloadNow: 0 };
  let settle!: { ready(): void; fail(message: string): void };
  const plugin = {
    ...fake.plugin,
    async downloadNow(options: { allowCellular: boolean }) {
      calls.downloadNow++;
      await fake.plugin.downloadNow(options);
      await new Promise<void>((resolve, reject) => {
        settle = {
          ready() {
            fake.controls.setModel("parakeet-tdt-0.6b-v3-int8", "ready", 640, 640);
            fake.controls.setModel("silero-vad", "ready", 2, 2);
            resolve();
          },
          fail: (message) => reject(new Error(message)),
        };
      });
    },
  } as OnDeviceSttPlugin;
  return { plugin, calls, ready: () => settle.ready(), fail: (message: string) => settle.fail(message) };
}

describe("the on-device model downloads on its own", () => {
  test("a note already waiting for the model starts the download, and is transcribed once the model is ready", async () => {
    const fake = createFakeOnDeviceStt();
    const native = downloading(fake);
    __setOnDeviceSttForTests(native.plugin);
    await fake.plugin.enqueue({ id: "n1" });
    await onDeviceSttStore.refresh();
    expect(native.calls.downloadNow).toBe(1);
    expect(onDeviceSttStore.snapshot().queue).toEqual([{ id: "n1", state: "waiting_for_model", percent: null, error: null }]);

    native.ready();
    await tick();
    await tick();
    expect(isOnDeviceReady(onDeviceSttStore.snapshot())).toBe(true);
    expect(onDeviceSttStore.downloadError()).toBeNull();
    expect(onDeviceSttStore.snapshot().queue[0]?.state).toBe("queued");
    expect(native.calls.downloadNow).toBe(1);

    const transcribed: unknown[] = [];
    await native.plugin.addListener("transcribed", (event) => void transcribed.push(event));
    fake.controls.finish("n1", "transcribed");
    expect(transcribed).toEqual([{ id: "n1", outcome: "transcribed" }]);
  });

  test("a relaunch mid-download starts it again and the waiting note keeps its place", async () => {
    const fake = createFakeOnDeviceStt();
    const native = downloading(fake);
    __setOnDeviceSttForTests(native.plugin);
    await fake.plugin.enqueue({ id: "n1" });
    await onDeviceSttStore.refresh();
    expect(native.calls.downloadNow).toBe(1);

    // The app is killed: the download lived in the process, so the new process finds the models gone and the note waiting.
    __resetOnDeviceSttStoreForTests();
    await fake.plugin.cancelDownload();
    await onDeviceSttStore.refresh();
    expect(native.calls.downloadNow).toBe(2);
    expect(onDeviceSttStore.snapshot().queue.map((job) => [job.id, job.state])).toEqual([["n1", "waiting_for_model"]]);

    native.ready();
    await tick();
    await tick();
    expect(onDeviceSttStore.snapshot().queue.map((job) => [job.id, job.state])).toEqual([["n1", "queued"]]);
  });

  test("a download native still reports as running is joined, never started twice", async () => {
    const fake = createFakeOnDeviceStt();
    const native = downloading(fake);
    __setOnDeviceSttForTests(native.plugin);
    await fake.plugin.enqueue({ id: "n1" });
    await fake.plugin.downloadNow({ allowCellular: false });
    await onDeviceSttStore.refresh();
    await onDeviceSttStore.refresh();
    expect(native.calls.downloadNow).toBe(0);
  });

  test("a failed download shows why, offers Try again, and is not restarted behind the user's back", async () => {
    const logged = spyOn(console, "error").mockImplementation(() => {});
    const fake = createFakeOnDeviceStt();
    const native = downloading(fake);
    __setOnDeviceSttForTests(native.plugin);
    await fake.plugin.enqueue({ id: "n1" });
    await onDeviceSttStore.refresh();
    native.fail("no space left");
    await tick();
    await tick();
    expect(onDeviceSttStore.downloadError()).toBe("Couldn't download the on-device model: no space left");
    expect(logged).toHaveBeenCalled();

    await onDeviceSttStore.refresh();
    expect(native.calls.downloadNow).toBe(1);

    const guide = localModelGuide(onDeviceSttStore.snapshot(), { start: () => void downloadOnDeviceModel(), error: onDeviceSttStore.downloadError() });
    expect(guide.reason).toBe("Couldn't download the on-device model: no space left");
    expect(guide.action?.label).toBe("Try again");
    guide.action!.run();
    expect(native.calls.downloadNow).toBe(2);
    expect(onDeviceSttStore.downloadError()).toBeNull();
    await tick();
    native.ready();
    await tick();
    await tick();
    expect(isOnDeviceReady(onDeviceSttStore.snapshot())).toBe(true);
    logged.mockRestore();
  });
});

describe("starting the on-device model download", () => {
  test("a download that finishes with the model ready reports nothing", async () => {
    const native = downloading(createFakeOnDeviceStt());
    __setOnDeviceSttForTests(native.plugin);
    const run = downloadOnDeviceModel();
    await tick();
    native.ready();
    expect(await run).toBeNull();
  });

  test("a download that finishes without the model ready says so, and is logged", async () => {
    const logged = spyOn(console, "error").mockImplementation(() => {});
    __setOnDeviceSttForTests(createFakeOnDeviceStt().plugin);
    expect(await downloadOnDeviceModel()).toBe("Couldn't download the on-device model: it finished downloading but is not ready");
    expect(logged).toHaveBeenCalledTimes(1);
    logged.mockRestore();
  });

  test("a request made before the first status arrives starts the download when it does", async () => {
    const fake = createFakeOnDeviceStt();
    const native = downloading(fake);
    __setOnDeviceSttForTests(native.plugin);
    ensureOnDeviceModel();
    expect(native.calls.downloadNow).toBe(0);
    await onDeviceSttStore.refresh();
    expect(native.calls.downloadNow).toBe(1);
  });

  test("nothing starts a download until something asks for one", async () => {
    const fake = createFakeOnDeviceStt();
    const native = downloading(fake);
    __setOnDeviceSttForTests(native.plugin);
    await onDeviceSttStore.refresh();
    await onDeviceSttStore.refresh();
    expect(native.calls.downloadNow).toBe(0);
  });

  test("a download still running when the store is reset leaves no error behind for the next test", async () => {
    const logged = spyOn(console, "error").mockImplementation(() => {});
    __setOnDeviceSttForTests(createFakeOnDeviceStt().plugin);
    const running = downloadOnDeviceModel();
    __resetOnDeviceSttStoreForTests();
    await running;
    expect(onDeviceSttStore.downloadError()).toBeNull();
    logged.mockRestore();
  });

  test("a download that cannot start is logged and handed back as the reason", async () => {
    const logged = spyOn(console, "error").mockImplementation(() => {});
    __setOnDeviceSttForTests({ ...createFakeOnDeviceStt().plugin, downloadNow: async () => { throw new Error("no space"); } } as unknown as OnDeviceSttPlugin);
    expect(await downloadOnDeviceModel()).toBe("Couldn't download the on-device model: no space");
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
