import { EyeIcon } from "lucide-react";
import { SectionCard } from "@/components/ui/section-card";
import { setShowHiddenFeatures, useShowHiddenFeatures } from "@/lib/hiddenFeatures";

export const HIDDEN_FEATURES_STRINGS = {
  title: "Hidden features",
  label: "Show hidden features",
  note: "Shows features that are off by default. This device only.",
} as const;

/** Settings → Hidden features. This device's setting; it doesn't sync. */
export function HiddenFeaturesSettings() {
  const show = useShowHiddenFeatures();
  return (
    <SectionCard icon={EyeIcon} title={HIDDEN_FEATURES_STRINGS.title}>
      <div data-testid="hidden-features-row" className="flex items-center justify-between gap-3">
        <p className="text-sm font-medium">{HIDDEN_FEATURES_STRINGS.label}</p>
        {/* A 44 px target on touch around the 44x24 track. */}
        <button type="button" role="switch" aria-checked={show} aria-label={HIDDEN_FEATURES_STRINGS.label}
          onClick={() => setShowHiddenFeatures(!show)}
          className="-my-2.5 flex h-11 w-12 shrink-0 items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring fine:my-0 fine:h-6 fine:w-11">
          <span aria-hidden className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${show ? "bg-primary" : "bg-muted"}`}>
            <span className={`absolute top-1 size-4 rounded-full bg-background transition-transform ${show ? "left-6" : "left-1"}`} />
          </span>
        </button>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">{HIDDEN_FEATURES_STRINGS.note}</p>
    </SectionCard>
  );
}
