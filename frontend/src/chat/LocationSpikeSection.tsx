// TC-524 location spike: a developer card in Connectors → Sources, compiled in
// only with VITE_EXO_LOCATION_SPIKE=true (ConnectorsPage lazy-loads it behind
// that build flag) and rendered only inside the Exo app when the native
// Location plugin exists (debug builds). It drives the permission ladder,
// starts and stops capture, shows everything the OS reports, and drains the
// native queue into the user's TinyCloud space. Not a product surface.
//
// `LocationSpikeView` is a pure function of its props; `LocationSpikeSection`
// owns the plugin, its events and the sync loop.

import { useCallback, useEffect, useRef, useState, type FC } from "react";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { Loader2Icon, MapPinIcon, RefreshCwIcon, SquareIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { SectionCard } from "@/components/ui/section-card";
import {
  Location,
  locationSpikeEnabled,
  nativeLocationAvailable,
  type LocationMode,
  type LocationSample,
  type LocationStartOptions,
  type LocationStateEvent,
  type LocationStatus,
} from "@/lib/location/nativeLocation";
import { listLocationBatchKeys, syncLocationQueue, utcDay } from "@/lib/location/locationStore";

export type ProviderOption = NonNullable<LocationStartOptions["provider"]>;

export interface CaptureOptions {
  mode: LocationMode;
  background: boolean;
  provider: ProviderOption;
}

export interface SyncState {
  running: boolean;
  /** Batches and queue entries written to the space since this card mounted. */
  batches: number;
  entries: number;
  lastSyncAt: number | null;
  lastError: string | null;
  /** Batches stored today (UTC) for this install, from a KV list; null until listed. */
  todayBatches: number | null;
}

export interface LocationSpikeViewProps {
  status: LocationStatus | null;
  error: string | null;
  /** The action in flight, if any. */
  busy: string | null;
  options: CaptureOptions;
  lastSample: LocationSample | null;
  /** Newest first. */
  events: LocationStateEvent[];
  sync: SyncState;
  now: number;
  onOptions: (next: CaptureOptions) => void;
  onRequestForeground: () => void;
  onRequestBackground: () => void;
  onOpenSettings: () => void;
  onStart: () => void;
  onStop: () => void;
  onSync: () => void;
  onRefresh: () => void;
}

const PERMISSION_TEXT: Record<LocationStatus["permission"], string> = {
  prompt: "Not asked yet",
  denied: "Denied (only Settings can change it)",
  restricted: "Restricted by the device (parental controls or management)",
  foreground: "While using the app",
  background: "All the time",
};

/** How "all the time" can be had from here, in the OS's own terms. */
export function backgroundRequestText(status: LocationStatus): string {
  const label = status.android?.backgroundOptionLabel ?? "Allow all the time";
  switch (status.backgroundRequest) {
    case "granted":
      return "Granted";
    case "foreground_first":
      return "Needs “while using the app” first";
    case "dialog":
      return `Ask in a dialog (“${label}”)`;
    case "settings":
      return status.platform === "android"
        ? `Only in Settings: Permissions → Location → “${label}”`
        : "Only in Settings: Location → Always (the one-time upgrade prompt was used)";
    case "upgrade_prompt":
      return "Ask once (“Change to Always Allow”)";
  }
}

export function formatAge(ms: number | null, now: number): string {
  if (ms === null) return "never";
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m ago`;
}

export function describeEvent(event: LocationStateEvent): string {
  const what = event.reason ?? (event.changed?.length ? event.changed.join(", ") : "");
  return `${event.change}${what ? `: ${what}` : ""}${event.detail ? ` (${event.detail})` : ""}`;
}

function yesNo(value: boolean | undefined | null): string {
  if (value === undefined || value === null) return "–";
  return value ? "yes" : "no";
}

/** Everything the OS reports, as label/value rows. */
export function osRows(status: LocationStatus): Array<[string, string]> {
  const rows: Array<[string, string]> = [
    ["Permission", PERMISSION_TEXT[status.permission]],
    ["Accuracy", status.accuracy ?? "–"],
    ["Background (“all the time”)", backgroundRequestText(status)],
    ["Location services", status.servicesEnabled ? "on" : "OFF"],
    [status.platform === "ios" ? "Low Power Mode" : "Battery saver", yesNo(status.lowPowerMode)],
    ["App on screen", yesNo(status.appVisible)],
  ];
  if (status.platform === "android") {
    rows.push(
      ["Battery saver location mode", status.locationPowerSaveMode ?? "–"],
      ["Doze", yesNo(status.deviceIdle)],
      ["Notifications (FGS notice visible)", yesNo(status.notificationsEnabled)],
      ["Background restricted", yesNo(status.android?.backgroundRestricted)],
      [
        "Providers",
        Object.entries(status.android?.providers ?? {})
          .map(([name, on]) => `${name}${on ? "" : " (off)"}`)
          .join(", ") || "–",
      ],
      ["Android API", String(status.android?.sdkInt ?? "–")],
    );
  } else {
    rows.push(
      ["Background App Refresh", status.backgroundRefresh ?? status.ios?.backgroundRefresh ?? "–"],
      ["Authorization (raw)", status.ios?.authorizationStatus ?? "–"],
      ["iOS", status.ios?.systemVersion ?? "–"],
    );
  }
  rows.push([
    "This build declares",
    [
      status.declared.foreground ? "while-in-use" : null,
      status.declared.background ? "all-the-time" : null,
      status.declared.backgroundExecution ? (status.platform === "android" ? "location FGS" : "background mode") : null,
    ]
      .filter(Boolean)
      .join(", ") || "nothing (release build?)",
  ]);
  return rows;
}

const selectClass = "rounded-md border border-border bg-background px-2 py-1 text-xs";

export const LocationSpikeView: FC<LocationSpikeViewProps> = (props) => {
  const { status, error, busy, options, lastSample, events, sync, now } = props;
  const tracking = status?.tracking;
  const live = tracking?.active === true;

  return (
    <SectionCard icon={MapPinIcon} title="Location (TC-524 spike)">
      <p className="text-xs text-muted-foreground">
        Developer build only. Records this phone&apos;s location into your TinyCloud space (under connectors/, for the
        prototype) and shows what the OS reports. Nothing starts until you press Start.
      </p>

      {status === null ? (
        <p className="mt-3 text-xs text-muted-foreground">Reading location status…</p>
      ) : (
        <>
          <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs" data-testid="location-os-state">
            {osRows(status).map(([label, value]) => (
              <div key={label} className="contents">
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="break-words">{value}</dd>
              </div>
            ))}
          </dl>

          <div className="mt-3 flex flex-wrap gap-2">
            <Button type="button" size="sm" variant="outline" disabled={busy !== null} onClick={props.onRequestForeground}>
              Allow while using
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy !== null || status.backgroundRequest === "granted" || status.backgroundRequest === "foreground_first"}
              onClick={props.onRequestBackground}
            >
              Allow all the time
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={props.onOpenSettings}>
              Open Settings
            </Button>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
            <select
              className={selectClass}
              value={options.mode}
              disabled={live}
              aria-label="Mode"
              onChange={(e) => props.onOptions({ ...options, mode: e.target.value as LocationMode })}
            >
              <option value="continuous">Continuous</option>
              <option value="low_power">Low power</option>
            </select>
            {status.platform === "android" && (
              <select
                className={selectClass}
                value={options.provider}
                disabled={live}
                aria-label="Provider"
                onChange={(e) => props.onOptions({ ...options, provider: e.target.value as ProviderOption })}
              >
                <option value="auto">Provider: auto</option>
                <option value="fused">fused</option>
                <option value="gps">gps</option>
                <option value="network">network</option>
                <option value="passive">passive</option>
              </select>
            )}
            <label className="flex items-center gap-1">
              <input
                type="checkbox"
                checked={options.background}
                disabled={live}
                onChange={(e) => props.onOptions({ ...options, background: e.target.checked })}
              />
              Keep going in the background
            </label>
          </div>

          <div className="mt-3 flex items-center gap-3">
            {live || tracking?.desired ? (
              <Button type="button" variant="destructive" onClick={props.onStop} disabled={busy !== null} data-testid="location-stop">
                <SquareIcon className="size-4" /> Stop
              </Button>
            ) : (
              <Button type="button" onClick={props.onStart} disabled={busy !== null} data-testid="location-start">
                {busy === "start" ? <Loader2Icon className="size-4 animate-spin" /> : <MapPinIcon className="size-4" />} Start
              </Button>
            )}
            <p role="status" className="min-w-0 flex-1 text-xs" data-testid="location-tracking" data-active={live ? "true" : "false"}>
              {live
                ? `Recording (${tracking?.mode}, ${tracking?.background ? "background on" : "foreground only"}; ${tracking?.sources.join(", ")})${tracking?.pausedByOs ? ", paused by the OS" : ""}`
                : tracking?.desired
                  ? "On, but the OS is not delivering (see events)"
                  : `Off${tracking?.lastStopReason ? ` (last stop: ${tracking.lastStopReason})` : ""}`}
            </p>
          </div>

          <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs" data-testid="location-capture">
            <dt className="text-muted-foreground">Last fix</dt>
            <dd data-testid="location-last-sample">
              {lastSample
                ? `${lastSample.lat.toFixed(5)}, ${lastSample.lon.toFixed(5)} ±${lastSample.accuracyM === null ? "?" : Math.round(lastSample.accuracyM)} m · ${lastSample.provider ?? "?"}${lastSample.mock ? " (mock)" : ""} · ${formatAge(lastSample.at, now)}`
                : `none (${formatAge(tracking?.lastSampleAt ?? null, now)})`}
            </dd>
            <dt className="text-muted-foreground">Samples this session</dt>
            <dd>{tracking?.sessionSamples ?? 0}</dd>
            <dt className="text-muted-foreground">Waiting on the phone</dt>
            <dd data-testid="location-queue">
              {status.queue.pending}
              {status.queue.dropped > 0 ? ` (${status.queue.dropped} dropped when the queue was full)` : ""}
            </dd>
            <dt className="text-muted-foreground">Saved to your space</dt>
            <dd data-testid="location-saved">
              {sync.entries} entries in {sync.batches} batches since opened
              {sync.todayBatches !== null ? `; ${sync.todayBatches} batches today` : ""}
              {sync.lastSyncAt !== null ? ` · synced ${formatAge(sync.lastSyncAt, now)}` : ""}
            </dd>
          </dl>
          <div className="mt-2 flex gap-2">
            <Button type="button" size="sm" variant="outline" onClick={props.onSync} disabled={sync.running} data-testid="location-sync">
              {sync.running ? <Loader2Icon className="size-4 animate-spin" /> : <RefreshCwIcon className="size-4" />} Save now
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={props.onRefresh}>
              Refresh status
            </Button>
          </div>
        </>
      )}

      {(error || sync.lastError) && (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {error ?? sync.lastError}
        </p>
      )}

      {events.length > 0 && (
        <ol className="mt-3 flex flex-col gap-0.5 text-xs text-muted-foreground" data-testid="location-events">
          {events.map((event, i) => (
            <li key={`${event.at}-${i}`}>
              <span className="tabular-nums">{new Date(event.at).toLocaleTimeString()}</span> {describeEvent(event)}
            </li>
          ))}
        </ol>
      )}
    </SectionCard>
  );
};

const MAX_EVENTS = 15;
/** While capturing and on screen, drain the queue this often. */
const SYNC_INTERVAL_MS = 30_000;

function messageOf(caught: unknown): string {
  if (caught instanceof Error) return caught.message;
  if (caught && typeof caught === "object" && "message" in caught && typeof caught.message === "string") return caught.message;
  return String(caught);
}

function LocationSpikeController({ tcw }: { tcw: TinyCloudWeb }) {
  const [status, setStatus] = useState<LocationStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [options, setOptions] = useState<CaptureOptions>({ mode: "continuous", background: true, provider: "auto" });
  const [lastSample, setLastSample] = useState<LocationSample | null>(null);
  const [events, setEvents] = useState<LocationStateEvent[]>([]);
  const [sync, setSync] = useState<SyncState>({ running: false, batches: 0, entries: 0, lastSyncAt: null, lastError: null, todayBatches: null });
  const [now, setNow] = useState(() => Date.now());
  const mounted = useRef(true);
  const statusRef = useRef<LocationStatus | null>(null);
  // One sync at a time: TinyCloud drops concurrent responses (the KV list below included).
  const syncing = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const next = await Location.status();
      statusRef.current = next;
      if (mounted.current) setStatus(next);
      return next;
    } catch (caught) {
      if (mounted.current) setError(messageOf(caught));
      return null;
    }
  }, []);

  const runSync = useCallback(async () => {
    if (syncing.current) return;
    syncing.current = true;
    try {
      const current = statusRef.current ?? (await refresh());
      if (!current) return;
      setSync((s) => ({ ...s, running: true }));
      const res = await syncLocationQueue(tcw, Location, { platform: current.platform, installId: current.installId });
      const listed = await listLocationBatchKeys(tcw, current.installId, utcDay(Date.now()));
      if (!mounted.current) return;
      setSync((s) => ({
        running: false,
        batches: s.batches + (res.ok ? res.data.batches : 0),
        entries: s.entries + (res.ok ? res.data.entries : 0),
        lastSyncAt: res.ok ? Date.now() : s.lastSyncAt,
        lastError: res.ok ? null : res.error.message,
        todayBatches: listed.ok ? listed.data.length : s.todayBatches,
      }));
      await refresh();
    } finally {
      syncing.current = false;
    }
  }, [refresh, tcw]);

  useEffect(() => {
    mounted.current = true;
    const handles = [
      Location.addListener("sample", (sample) => {
        setLastSample(sample);
        void refresh();
      }),
      Location.addListener("state", (event) => {
        setEvents((current) => [event, ...current].slice(0, MAX_EVENTS));
        void refresh();
      }),
    ];
    // Whatever was recorded while this view was not around (background, a relaunch) goes up now.
    void refresh().then(() => runSync());
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh().then(() => runSync());
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      mounted.current = false;
      document.removeEventListener("visibilitychange", onVisible);
      for (const handle of handles) void handle.then((h) => h.remove());
    };
  }, [refresh, runSync]);

  const active = status?.tracking.active === true;
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 1_000);
    const syncer = active ? setInterval(() => void runSync(), SYNC_INTERVAL_MS) : null;
    return () => {
      clearInterval(tick);
      if (syncer) clearInterval(syncer);
    };
  }, [active, runSync]);

  const act = useCallback(
    async (name: string, action: () => Promise<LocationStatus | void>) => {
      setBusy(name);
      setError(null);
      try {
        const next = await action();
        if (next && mounted.current) {
          statusRef.current = next;
          setStatus(next);
        }
      } catch (caught) {
        if (mounted.current) setError(messageOf(caught));
      } finally {
        if (mounted.current) setBusy(null);
      }
    },
    [],
  );

  return (
    <LocationSpikeView
      status={status}
      error={error}
      busy={busy}
      options={options}
      lastSample={lastSample}
      events={events}
      sync={sync}
      now={now}
      onOptions={setOptions}
      onRequestForeground={() => void act("foreground", () => Location.requestPermission({ level: "foreground" }))}
      onRequestBackground={() => void act("background", () => Location.requestPermission({ level: "background" }))}
      onOpenSettings={() => void act("settings", () => Location.openSettings())}
      onStart={() => void act("start", () => Location.start(options))}
      onStop={() =>
        void act("stop", async () => {
          const next = await Location.stop();
          void runSync();
          return next;
        })
      }
      onSync={() => void runSync()}
      onRefresh={() => void refresh()}
    />
  );
}

/** Renders nothing unless this build has the spike flag and the app has the native plugin (debug builds). */
export function LocationSpikeSection({ tcw }: { tcw: TinyCloudWeb }) {
  if (!locationSpikeEnabled() || !nativeLocationAvailable()) return null;
  return <LocationSpikeController tcw={tcw} />;
}

export default LocationSpikeSection;
