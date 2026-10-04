// The TC-524 location spike's developer card. `LocationSpikeView` is a pure function of its props, asserted against
// real markup via react-dom/server:
//   1. it renders nothing without the build flag or outside the native app;
//   2. every OS-reported state is shown, in each OS's own terms (Android's Settings label, iOS's one-time upgrade);
//   3. "all the time" is offered only after "while using the app";
//   4. capture that is wanted but not delivered says so instead of looking off;
//   5. state events read as change + reason.

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import {
  LocationSpikeSection,
  LocationSpikeView,
  backgroundRequestText,
  describeEvent,
  formatAge,
  osRows,
  type LocationSpikeViewProps,
} from "./LocationSpikeSection";
import { locationSpikeEnabled, type LocationStatus } from "@/lib/location/nativeLocation";

const noop = () => {};

function androidStatus(patch: Partial<LocationStatus> = {}): LocationStatus {
  return {
    platform: "android",
    installId: "inst-1",
    permission: "foreground",
    accuracy: "precise",
    servicesEnabled: true,
    lowPowerMode: false,
    appVisible: true,
    locationPowerSaveMode: "no_change",
    deviceIdle: false,
    notificationsEnabled: true,
    backgroundRequest: "settings",
    declared: { foreground: true, background: true, backgroundExecution: true, precise: true },
    tracking: {
      desired: false,
      active: false,
      mode: "continuous",
      background: true,
      sources: [],
      intervalMs: 10_000,
      distanceM: 0,
      startedAt: null,
      lastSampleAt: null,
      sessionSamples: 0,
      pausedByOs: false,
      lastStopReason: null,
      foregroundService: false,
    },
    queue: { pending: 0, dropped: 0 },
    android: { sdkInt: 36, backgroundOptionLabel: "Allow all the time", providers: { fused: true, gps: true, network: false } },
    ...patch,
  };
}

function view(patch: Partial<LocationSpikeViewProps> = {}): string {
  const props: LocationSpikeViewProps = {
    status: androidStatus(),
    error: null,
    busy: null,
    options: { mode: "continuous", background: true, provider: "auto" },
    lastSample: null,
    events: [],
    sync: { running: false, batches: 0, entries: 0, lastSyncAt: null, lastError: null, todayBatches: null },
    now: Date.parse("2026-10-04T08:00:00.000Z"),
    onOptions: noop,
    onRequestForeground: noop,
    onRequestBackground: noop,
    onOpenSettings: noop,
    onStart: noop,
    onStop: noop,
    onSync: noop,
    onRefresh: noop,
    ...patch,
  };
  return renderToStaticMarkup(<LocationSpikeView {...props} />);
}

describe("LocationSpikeSection gate", () => {
  test("the flag must be exactly \"true\"", () => {
    expect(locationSpikeEnabled({})).toBe(false);
    expect(locationSpikeEnabled({ VITE_EXO_LOCATION_SPIKE: "1" })).toBe(false);
    expect(locationSpikeEnabled({ VITE_EXO_LOCATION_SPIKE: "true" })).toBe(true);
  });

  test("renders nothing in a normal build or outside the native app", () => {
    expect(renderToStaticMarkup(<LocationSpikeSection tcw={{} as TinyCloudWeb} />)).toBe("");
  });
});

describe("LocationSpikeView", () => {
  test("shows what the OS reports, in Android's terms", () => {
    const rows = Object.fromEntries(osRows(androidStatus({ lowPowerMode: true, locationPowerSaveMode: "gps_disabled_when_screen_off" })));
    expect(rows["Permission"]).toBe("While using the app");
    expect(rows["Background (“all the time”)"]).toBe("Only in Settings: Permissions → Location → “Allow all the time”");
    expect(rows["Battery saver"]).toBe("yes");
    expect(rows["Battery saver location mode"]).toBe("gps_disabled_when_screen_off");
    expect(rows["Providers"]).toBe("fused, gps, network (off)");
    expect(rows["This build declares"]).toBe("while-in-use, all-the-time, location FGS");
  });

  test("iOS: the one-time upgrade prompt, then Settings", () => {
    const ios = androidStatus({ platform: "ios", android: undefined, backgroundRequest: "upgrade_prompt", backgroundRefresh: "available" });
    expect(backgroundRequestText(ios)).toBe("Ask once (“Change to Always Allow”)");
    expect(backgroundRequestText({ ...ios, backgroundRequest: "settings" })).toContain("upgrade prompt was used");
    expect(Object.fromEntries(osRows(ios))["Low Power Mode"]).toBe("no");
  });

  test("a release build declares nothing", () => {
    const rows = Object.fromEntries(
      osRows(androidStatus({ declared: { foreground: false, background: false, backgroundExecution: false } })),
    );
    expect(rows["This build declares"]).toBe("nothing (release build?)");
  });

  test("\"all the time\" is disabled until while-in-use is granted", () => {
    const html = view({ status: androidStatus({ permission: "prompt", accuracy: null, backgroundRequest: "foreground_first" }) });
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Allow all the time<\/button>/);
    expect(view()).not.toMatch(/<button[^>]*disabled=""[^>]*>Allow all the time<\/button>/);
  });

  test("off, recording, and wanted-but-not-delivered read differently", () => {
    expect(view()).toContain('data-active="false"');
    expect(view()).toContain("data-testid=\"location-start\"");
    const base = androidStatus().tracking;
    const recording = view({
      status: androidStatus({ tracking: { ...base, desired: true, active: true, sources: ["fused"], foregroundService: true } }),
    });
    expect(recording).toContain("Recording (continuous, background on; fused)");
    expect(recording).toContain('data-testid="location-stop"');
    const stalled = view({ status: androidStatus({ tracking: { ...base, desired: true, active: false } }) });
    expect(stalled).toContain("On, but the OS is not delivering");
    expect(stalled).toContain('data-testid="location-stop"');
  });

  test("events read as change and reason", () => {
    const state = { permission: "foreground", accuracy: "precise", servicesEnabled: false, lowPowerMode: false, appVisible: false } as const;
    expect(describeEvent({ kind: "state", at: 0, change: "services", reason: null, changed: ["servicesEnabled"], state })).toBe(
      "services: servicesEnabled",
    );
    expect(describeEvent({ kind: "state", at: 0, change: "tracking", reason: "fgs_start_denied", detail: "SecurityException: x", state })).toBe(
      "tracking: fgs_start_denied (SecurityException: x)",
    );
    expect(formatAge(null, 0)).toBe("never");
    expect(formatAge(0, 95_000)).toBe("1m ago");
  });
});
