import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { createFakeOnDeviceStt } from "./fakeOnDeviceStt";
import { __setOnDeviceSttForTests, type OnDeviceSttPlugin } from "./onDeviceStt";
import { downloadOnDeviceModel, retryOnDeviceNote } from "./onDeviceSttStore";

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
