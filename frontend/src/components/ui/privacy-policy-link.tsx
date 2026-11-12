import { ExternalLinkIcon } from "lucide-react";

import { openPrivacyPolicy } from "@/lib/openPrivacyPolicy";
import { cn } from "@/lib/utils";

/** A quiet link to TinyCloud's privacy policy, opened outside the app (see openPrivacyPolicy). */
export function PrivacyPolicyLink(props: { className?: string }) {
  return (
    <button
      type="button"
      onClick={() => void openPrivacyPolicy()}
      className={cn(
        "inline-flex min-h-11 w-fit items-center gap-1 text-meta font-medium text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring fine:min-h-0",
        props.className,
      )}
    >
      Privacy policy
      <ExternalLinkIcon className="size-3.5" aria-hidden="true" />
    </button>
  );
}
