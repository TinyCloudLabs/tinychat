import { CANONICAL_ORIGIN, LEGACY_HOSTNAMES } from "@/lib/originMove";

export const LEGACY_DATA_INTRO =
  "Recordings, answers and settings saved in this browser on an old address are still there. Open that address to get to them.";

const CANONICAL_HOSTNAME = new URL(CANONICAL_ORIGIN).hostname;

/** Where a legacy origin's own data is reached: `?legacy=1` keeps the page there instead of moving it (originMove.ts). */
export const legacyDataUrl = (hostname: string) => `https://${hostname}/?legacy=1`;

/**
 * Settings' way back to the old addresses, shown only on tinycloud.one: that is where a visitor who moved from a
 * legacy origin, which does not share storage with it, looks for what they left there.
 */
export function LegacyDataLinks({ hostname = window.location.hostname }: { hostname?: string }) {
  if (hostname !== CANONICAL_HOSTNAME) return null;
  return (
    <div className="mt-4">
      <p className="text-xs text-muted-foreground">{LEGACY_DATA_INTRO}</p>
      <ul className="mt-2 space-y-1 text-sm">
        {LEGACY_HOSTNAMES.map((legacy) => (
          <li key={legacy}>
            <a href={legacyDataUrl(legacy)} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">
              {legacy}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
