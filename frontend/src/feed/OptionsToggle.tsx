import { ChevronDownIcon } from "lucide-react";

/** How much of the post a screen reader hears after the visible words. */
const NAME_POST_CHARS = 80;

/**
 * The quiet line of a card that asks: "See 3 options" under its folded row, "Hide options" under its post
 * once it is open. It is a second opener of the same card: tapping it does what tapping the post does. Its name starts
 * with its visible words, then says which post it is for. It does not move focus: the first option is the next stop.
 * `inset` lines it up under a row's text, beside the agent's mark.
 */
export function OptionsToggle({ count, post, open, controls, inset = false, onToggle }: { count: number; post: string; open: boolean; controls: string; inset?: boolean; onToggle: () => void }) {
  const words = open ? "Hide options" : `See ${count} ${count === 1 ? "option" : "options"}`;
  const text = post.replace(/\s+/g, " ").trim();
  const name = `${words} for ${text.length > NAME_POST_CHARS ? `${text.slice(0, NAME_POST_CHARS)}…` : text}`;
  return <div className={inset ? "-mt-2.5 pl-[calc(3.5rem-0.375rem)] pr-4 min-[600px]:pl-[calc(3.75rem-0.375rem)] min-[600px]:pr-5" : "-mb-1.5 mt-1 -ml-1.5"}>
    <button type="button" aria-expanded={open} aria-controls={controls} aria-label={name} onClick={onToggle}
      className="inline-flex min-h-11 items-center gap-[3px] rounded-[8px] px-1.5 text-[13px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring fine:min-h-9">
      {words}<ChevronDownIcon aria-hidden className={`size-3.5 transition-transform duration-150 motion-reduce:transition-none ${open ? "rotate-180" : ""}`} />
    </button>
  </div>;
}
