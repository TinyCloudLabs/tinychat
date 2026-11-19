import { LockIcon } from "lucide-react";
import { SectionCard } from "@/components/ui/section-card";
import { SegmentedControl, type SegmentedOption } from "@/components/ui/segmented-control";
import { appLock, biometryName, LOCK_TIMEOUT_MINUTES, useAppLock, type LockTimeoutMinutes } from "@/lib/appLock";
import { APP_NAME } from "@/lib/homeSite";

const TIMEOUT_OPTIONS: readonly SegmentedOption<`${LockTimeoutMinutes}`>[] = LOCK_TIMEOUT_MINUTES.map((minutes) => ({
  value: `${minutes}`,
  label: minutes === 60 ? "1 hour" : `${minutes} min`,
}));

/** Settings → App lock (TC-2738): the phone app only. This device's setting; it doesn't sync. */
export function AppLockSettings() {
  const { prefs, device, supported } = useAppLock();
  if (!supported) return null;
  const lock = appLock();
  const name = biometryName(device);
  const available = device?.deviceSecure === true;
  const enabled = available && prefs.enabled === true;
  return (
    <SectionCard icon={LockIcon} title="App lock">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-medium">Require {name}</p>
        {/* A 44 px target on touch around the 44x24 track. */}
        <button type="button" role="switch" aria-checked={enabled} aria-label={`Require ${name}`} disabled={!available}
          onClick={() => lock.setEnabled(!enabled)}
          className="-my-2.5 flex h-11 w-12 shrink-0 items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 fine:my-0 fine:h-6 fine:w-11">
          <span aria-hidden className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${enabled ? "bg-primary" : "bg-muted"}`}>
            <span className={`absolute top-1 size-4 rounded-full bg-background transition-transform ${enabled ? "left-6" : "left-1"}`} />
          </span>
        </button>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        {available
          ? `${APP_NAME} asks for ${name} when it opens, and when you come back to it after a while.`
          : `Set a screen lock on this phone to lock ${APP_NAME}.`}
      </p>
      {enabled && (
        <div className="mt-4 flex flex-col gap-2">
          <p className="text-xs text-muted-foreground">Lock after time away</p>
          <SegmentedControl
            aria-label="Lock after time away"
            size="compact"
            value={`${prefs.timeoutMinutes}`}
            onValueChange={(value) => lock.setTimeoutMinutes(Number(value) as LockTimeoutMinutes)}
            options={TIMEOUT_OPTIONS}
            className="w-full sm:max-w-xs"
          />
        </div>
      )}
    </SectionCard>
  );
}
