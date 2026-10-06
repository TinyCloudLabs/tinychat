import type { LucideIcon } from "lucide-react";

/** Titled card used for the top-level blocks of Settings and the pages that
 *  borrow its layout language. */
export function SectionCard(props: {
  icon: LucideIcon;
  title: string;
  children?: React.ReactNode;
}) {
  const Icon = props.icon;
  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-center gap-2">
        <Icon className="size-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold tracking-tight">{props.title}</h2>
      </div>
      {props.children && <div className="mt-3">{props.children}</div>}
    </section>
  );
}
