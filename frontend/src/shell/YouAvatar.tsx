// One's new navigation (ONE_NAV_ENABLED): You's avatar, the last item of the phone's pill and the sidebar's foot, both
// leading to Settings.
import { UserRoundIcon } from "lucide-react";

import { cn } from "@/lib/utils";

export function YouAvatar({ active, className }: { active: boolean; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex size-7 shrink-0 items-center justify-center rounded-full bg-[#2b3157] text-[#fdf9d2]",
        active && "shadow-[0_0_0_2px_hsl(var(--background)),0_0_0_3.5px_hsl(var(--foreground))]",
        className,
      )}
    >
      <UserRoundIcon className="size-4" />
    </span>
  );
}
