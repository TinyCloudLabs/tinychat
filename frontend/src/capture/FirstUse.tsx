// First use: before anything has been captured, the Capture screen says what it is for.
import { HowItWorksLink } from "@/components/ui/how-it-works-link";
import type { AppPlatform } from "@/lib/platform";

export function FirstUse(props: { platform: AppPlatform; className?: string }) {
  const records = props.platform !== "web";
  return (
    <div className={props.className} data-testid="capture-first-use">
      <p className="font-display text-display">{records ? "Think out loud." : "Bring in a conversation."}</p>
      <p className="mt-2 max-w-[34ch] text-body text-muted-foreground">Everything you capture is saved to your TinyCloud space.</p>
      <HowItWorksLink section="capture" className="mt-1" />
    </div>
  );
}
