// Health spike (TC-525): a DEVELOPMENT-ONLY card in Connectors → Sources that drives the native Health plugin
// end to end: availability, the OS permission sheet, a 7-day read, and a save of the daily summaries to the
// user's TinyCloud space. ConnectorsPage loads it only when the build sets VITE_EXO_HEALTH_SPIKE=true, and it
// renders nothing unless the app's Health plugin exists (Android, and iOS Debug builds). Not product UI: no
// onboarding, no consent copy beyond what the OS shows, no background sync.
//
// `HealthSpikeView` is a pure function of its props; `HealthSpikeSection` owns the plugin calls.

import { useCallback, useEffect, useState } from "react";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { HeartPulseIcon, Loader2Icon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { SectionCard } from "@/components/ui/section-card";
import { healthDailyKvPrefix, saveHealthDailySummaries, type HealthSaveOutcome } from "@/lib/health/healthStore";
import {
  HEALTH_DATA_TYPES,
  HEALTH_TYPE_LABELS,
  Health,
  describeMissing,
  describeReadAuthorization,
  nativeHealthAvailable,
  readHealthDailySummaries,
  type HealthAuthorization,
  type HealthAvailability,
  type HealthDailySummaries,
} from "@/lib/health/nativeHealth";

export type HealthAction = "request" | "sampleAccess" | "sample" | "read" | "save" | "settings" | "background";

export interface HealthSpikeViewProps {
  availability: HealthAvailability | null;
  authorization: HealthAuthorization | null;
  summaries: HealthDailySummaries | null;
  saved: HealthSaveOutcome | null;
  busy: HealthAction | null;
  error: string | null;
  notice: string | null;
  onAction: (action: HealthAction) => void;
}

export function platformLabel(availability: HealthAvailability): string {
  if (availability.platform === "ios") return "HealthKit (iOS)";
  return `Health Connect (Android, API ${availability.sdkInt ?? "?"})`;
}

export function availabilityText(availability: HealthAvailability): string {
  if (availability.status === "available") {
    return availability.permissionsDeclared ? "Available." : "Available, but this build declares no health permissions (release build).";
  }
  if (availability.status === "needs_update") return "Health Connect must be updated from the Play Store first.";
  switch (availability.reason) {
    case "os_too_old":
      return "Not available: Health Connect needs Android 9 or later.";
    case "not_installed":
      return "Not available: install Health Connect from the Play Store (Android 9 to 13).";
    case "device_unsupported":
      return "Not available: this device has no Health data (HealthKit).";
    default:
      return "Not available on this device.";
  }
}

export function formatMinutes(minutes: number): string {
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")} min`;
}

const ACTION_LABELS: Record<HealthAction, string> = {
  request: "Ask for access",
  sampleAccess: "Allow sample data",
  sample: "Add sample data",
  read: "Read last 7 days",
  save: "Save to my space",
  settings: "Open Health settings",
  background: "Background delivery",
};

export function HealthSpikeView(props: HealthSpikeViewProps) {
  const { availability, authorization, summaries, saved, busy, error, notice, onAction } = props;
  const available = availability?.status === "available";
  const button = (action: HealthAction, enabled: boolean, variant: "default" | "outline" = "outline") => (
    <Button
      type="button"
      size="sm"
      variant={variant}
      disabled={!enabled || busy !== null}
      onClick={() => onAction(action)}
      data-testid={`health-${action}`}
    >
      {busy === action && <Loader2Icon className="size-4 animate-spin" />} {ACTION_LABELS[action]}
    </Button>
  );
  const missing = describeMissing(summaries?.readStateKnowable ?? authorization?.readStateKnowable ?? true);

  return (
    <SectionCard icon={HeartPulseIcon} title="Health (development preview)">
      <p className="text-xs text-muted-foreground">
        Steps, sleep and heart rate from this phone, summarized per day and saved to your TinyCloud space. A build
        flag turns this card on; it is not part of the product.
      </p>

      {!availability && <p className="mt-2 text-xs text-muted-foreground">Checking…</p>}
      {availability && (
        <p className="mt-2 text-sm" data-testid="health-availability">
          <span className="font-medium">{platformLabel(availability)}:</span> {availabilityText(availability)}
        </p>
      )}

      {authorization && (
        <ul className="mt-2 flex flex-col gap-0.5 text-xs" data-testid="health-authorization">
          {HEALTH_DATA_TYPES.map((type) => (
            <li key={type}>
              <span className="font-medium">{HEALTH_TYPE_LABELS[type]}:</span>{" "}
              {describeReadAuthorization(authorization.types[type])}
            </li>
          ))}
          {authorization.background !== "not_applicable" && (
            <li>
              <span className="font-medium">Background reads:</span> {authorization.background.replace("_", " ")}
            </li>
          )}
        </ul>
      )}

      <div className="mt-3 flex flex-wrap gap-2">
        {availability?.status === "needs_update" && button("settings", true, "default")}
        {button("request", available, "default")}
        {button("read", available)}
        {button("save", summaries !== null)}
        {button("settings", available)}
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        {button("sampleAccess", available)}
        {button("sample", available && authorization?.sampleWrite === "granted")}
        {availability?.platform === "ios" && button("background", available)}
      </div>

      {error && (
        <p role="alert" className="mt-2 text-xs text-destructive" data-testid="health-error">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="mt-2 text-xs text-muted-foreground" data-testid="health-notice">
          {notice}
        </p>
      )}

      {summaries && (
        <div className="mt-3" data-testid="health-summaries">
          {summaries.notGranted.length > 0 && (
            <p className="text-xs text-muted-foreground">
              Not read ({summaries.platform === "ios" ? "never asked for" : "not allowed"}):{" "}
              {summaries.notGranted.map((t) => HEALTH_TYPE_LABELS[t]).join(", ")}.
            </p>
          )}
          <table className="mt-1 w-full text-left text-xs">
            <thead className="text-muted-foreground">
              <tr>
                <th className="py-1 font-medium">Day</th>
                <th className="py-1 font-medium">Steps</th>
                <th className="py-1 font-medium">Asleep</th>
                <th className="py-1 font-medium">Heart rate</th>
              </tr>
            </thead>
            <tbody>
              {summaries.days.map((day) => (
                <tr key={day.date} data-testid="health-day" className="border-t border-border">
                  <td className="py-1">{day.date}</td>
                  <td className="py-1">{day.steps === undefined ? "–" : day.steps === null ? "—" : day.steps.toLocaleString()}</td>
                  <td className="py-1">
                    {day.sleepMinutes === undefined ? "–" : day.sleepMinutes === null ? "—" : formatMinutes(day.sleepMinutes)}
                  </td>
                  <td className="py-1">
                    {day.heartRate === undefined
                      ? "–"
                      : day.heartRate === null
                        ? "—"
                        : `${day.heartRate.avg} (${day.heartRate.min}–${day.heartRate.max}) bpm`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-1 text-xs text-muted-foreground">
            — means {missing}. Time zone {summaries.timeZone}. Recorded by:{" "}
            {[...new Set(summaries.days.flatMap((d) => d.sources))].join(", ") || "nobody"}.
          </p>
        </div>
      )}

      {saved && (
        <p className="mt-2 text-xs text-muted-foreground" data-testid="health-saved">
          Saved {saved.saved.length} {saved.saved.length === 1 ? "day" : "days"}
          {saved.skipped > 0 && ` (${saved.skipped} with no data skipped)`} to your space under{" "}
          <code>{summaries ? healthDailyKvPrefix(summaries.source) : "connectors/exo-health/"}</code>. Prototype location:
          a shipped version gets its own health permission.
        </p>
      )}
    </SectionCard>
  );
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) return String((error as { message: unknown }).message);
  return String(error);
}

function HealthSpikeController({ tcw }: { tcw: TinyCloudWeb }) {
  const [availability, setAvailability] = useState<HealthAvailability | null>(null);
  const [authorization, setAuthorization] = useState<HealthAuthorization | null>(null);
  const [summaries, setSummaries] = useState<HealthDailySummaries | null>(null);
  const [saved, setSaved] = useState<HealthSaveOutcome | null>(null);
  const [busy, setBusy] = useState<HealthAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const found = await Health.availability();
    setAvailability(found);
    if (found.status === "available") setAuthorization(await Health.authorizationStatus());
  }, []);

  useEffect(() => {
    refresh().catch((e: unknown) => setError(messageOf(e)));
  }, [refresh]);

  const run = useCallback(
    async (action: HealthAction) => {
      setBusy(action);
      setError(null);
      setNotice(null);
      try {
        switch (action) {
          case "request":
            setAuthorization(await Health.requestAuthorization({ background: availability?.backgroundRead === "available" }));
            break;
          case "sampleAccess":
            setAuthorization(await Health.requestAuthorization({ sampleWrite: true }));
            break;
          case "sample": {
            const { inserted } = await Health.insertSampleData();
            setNotice(`Added ${inserted} sample records as Exo. Read again to see them.`);
            break;
          }
          case "read":
            setSummaries(await readHealthDailySummaries({ days: 7 }));
            setSaved(null);
            break;
          case "save": {
            if (!summaries) break;
            const result = await saveHealthDailySummaries(tcw, summaries);
            if (!result.ok) throw new Error(result.error.message);
            setSaved(result.data);
            break;
          }
          case "settings":
            await Health.openSettings();
            break;
          case "background": {
            const result = await Health.enableBackgroundDelivery({ types: ["steps"] });
            const failed = Object.entries(result.errors).map(([type, message]) => `${type}: ${message}`);
            setNotice(
              failed.length > 0
                ? `Background delivery failed: ${failed.join("; ")}`
                : `Background delivery on for ${result.enabled.join(", ")} (${result.frequency}).`,
            );
            break;
          }
        }
        if (action === "settings") await refresh();
      } catch (e) {
        setError(messageOf(e));
      } finally {
        setBusy(null);
      }
    },
    [availability, refresh, summaries, tcw],
  );

  return (
    <HealthSpikeView
      availability={availability}
      authorization={authorization}
      summaries={summaries}
      saved={saved}
      busy={busy}
      error={error}
      notice={notice}
      onAction={(action) => void run(action)}
    />
  );
}

/** Renders nothing unless the app's native Health plugin exists. ConnectorsPage gates on the build flag. */
export function HealthSpikeSection({ tcw }: { tcw: TinyCloudWeb }) {
  if (!nativeHealthAvailable()) return null;
  return <HealthSpikeController tcw={tcw} />;
}
