import type * as React from "react";
import { Link } from "react-router-dom";
import { ChevronRightIcon } from "lucide-react";

import { aboutHref, type AboutSectionId } from "@/lib/about";
import { cn } from "@/lib/utils";

/** A quiet link to one section of the How it works page, in place of a paragraph of explanation. */
export function HowItWorksLink(props: { section: AboutSectionId; children?: React.ReactNode; className?: string }) {
  return (
    <Link
      to={aboutHref(props.section)}
      className={cn(
        "inline-flex min-h-11 items-center gap-0.5 text-meta font-medium text-muted-foreground underline-offset-4 transition-colors hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring fine:min-h-0",
        props.className,
      )}
    >
      {props.children ?? "How it works"}
      <ChevronRightIcon className="size-3.5" aria-hidden="true" />
    </Link>
  );
}
