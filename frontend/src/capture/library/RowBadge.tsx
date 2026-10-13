import type { ReactNode } from "react";

/** The small tag before a row's line for a note not yet settled in the space ("On this phone", "Saving…"). */
export function RowBadge(props: { children: ReactNode }) {
  return (
    <span
      className="inline-block shrink-0 rounded-full border border-current px-1.5 text-[11px] font-semibold leading-4"
      data-testid="row-badge"
    >
      {props.children}
    </span>
  );
}
