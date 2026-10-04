// Health spike (TC-525) card. `HealthSpikeView` is a pure function of its props, asserted against real markup:
//   1. outside the native app (no Health plugin) the section renders nothing;
//   2. availability is told as the platform reports it, including "needs update" with a way to fix it;
//   3. iOS read states never claim "allowed", and a missing value reads "no data, or not allowed";
//   4. actions that cannot work are disabled (no access before Health is available, no save before a read,
//      no sample data before write access);
//   5. a save says where the summaries went.

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { HealthSpikeSection, HealthSpikeView, formatMinutes, type HealthSpikeViewProps } from "./HealthSpikeSection";
import type { HealthAuthorization, HealthAvailability, HealthDailySummaries } from "@/lib/health/nativeHealth";

const androidAvailable: HealthAvailability = {
  platform: "android",
  status: "available",
  reason: null,
  sdkInt: 36,
  permissionsDeclared: true,
  backgroundRead: "available",
  historyRead: "available",
};

const iosAuthorization: HealthAuthorization = {
  readStateKnowable: false,
  types: { steps: "unknown", sleep: "unknown", heartRate: "not_determined" },
  background: "not_applicable",
  sampleWrite: "not_granted",
};

const iosSummaries: HealthDailySummaries = {
  platform: "ios",
  source: "healthkit",
  timeZone: "America/New_York",
  readAt: 0,
  readStateKnowable: false,
  notGranted: ["heartRate"],
  days: [{ date: "2026-10-04", steps: null, sleepMinutes: 412, sleepBlocks: 1, heartRate: null, sources: ["com.apple.Health"] }],
};

function render(patch: Partial<HealthSpikeViewProps> = {}): string {
  return renderToStaticMarkup(
    <HealthSpikeView
      availability={androidAvailable}
      authorization={null}
      summaries={null}
      saved={null}
      busy={null}
      error={null}
      notice={null}
      onAction={() => {}}
      {...patch}
    />,
  );
}

function disabled(html: string, action: string): boolean {
  const match = html.match(new RegExp(`<button[^>]*data-testid="health-${action}"[^>]*>`));
  if (!match) throw new Error(`no ${action} button`);
  return /\sdisabled=""/.test(match[0]);
}

describe("HealthSpikeSection", () => {
  test("renders nothing outside the native app", () => {
    expect(renderToStaticMarkup(<HealthSpikeSection tcw={{} as TinyCloudWeb} />)).toBe("");
  });

  test("Android availability names Health Connect and the API level", () => {
    expect(render()).toContain("Health Connect (Android, API 36)");
  });

  test("a release build without health permissions says so", () => {
    expect(render({ availability: { ...androidAvailable, permissionsDeclared: false } })).toContain("declares no health permissions");
  });

  test("needs update offers Health Connect settings and blocks access", () => {
    const html = render({ availability: { ...androidAvailable, status: "needs_update", reason: "provider_update_required" } });
    expect(html).toContain("must be updated");
    expect(disabled(html, "request")).toBe(true);
  });

  test("iOS read state is described as hidden, never allowed", () => {
    const html = render({
      availability: { ...androidAvailable, platform: "ios", sdkInt: undefined, backgroundRead: "unknown" },
      authorization: iosAuthorization,
      summaries: iosSummaries,
    });
    expect(html).toContain("HealthKit (iOS)");
    expect(html).toContain("does not tell apps");
    expect(html).not.toContain("Allowed");
    expect(html).toContain("no data, or not allowed");
    expect(html).toContain("never asked for");
    expect(html).toContain(formatMinutes(412));
  });

  test("save needs a read, sample data needs write access", () => {
    expect(disabled(render(), "save")).toBe(true);
    expect(disabled(render({ summaries: iosSummaries }), "save")).toBe(false);
    expect(disabled(render({ authorization: iosAuthorization }), "sample")).toBe(true);
    expect(disabled(render({ authorization: { ...iosAuthorization, sampleWrite: "granted" } }), "sample")).toBe(false);
  });

  test("a save says how many days went where", () => {
    const html = render({ summaries: iosSummaries, saved: { saved: ["2026-10-04"], skipped: 2 } });
    expect(html).toContain("Saved 1 day");
    expect(html).toContain("2 with no data skipped");
    expect(html).toContain("connectors/exo-health/healthkit/daily/");
  });

  test("formatMinutes", () => {
    expect(formatMinutes(412)).toBe("6 h 52 min");
    expect(formatMinutes(5)).toBe("0 h 05 min");
  });
});
