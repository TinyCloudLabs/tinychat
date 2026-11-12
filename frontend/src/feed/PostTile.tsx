// Feed lab (Sam, 11-12): a post as a tile in the grid view. Tapping it grows the tile into the post's page. The
// tile, its picture and its title are the same elements as the page's (motion's shared `layoutId`), so the picture
// you tapped is the picture you land on, and closing the page shrinks it back into its tile. The idea comes from
// Aceternity's Layout Grid and Expandable Card (the motion picks, §2); the tile itself is the feed's own.
import { motion, useReducedMotion, type Transition } from "motion/react";
import { PlayIcon } from "lucide-react";

import { AgentMark } from "./AgentMark";
import { StatusMark } from "./CompactCard";
import type { HomeFeedEntry } from "./feedStoreTypes";
import type { LabPage } from "./PostPage";
import { ShortTime } from "./ShortTime";

/** The name a post's tile and its page share, from the card's key. Pass it to PostPage as `morphFrom`. */
export const postMorphId = (entry: HomeFeedEntry) => `post:${entry.source.sourceId}:${entry.state.card.cardId}`;
export const morphImageId = (morphId: string) => `${morphId}:image`;
export const morphTitleId = (morphId: string) => `${morphId}:title`;

/**
 * How the tile and the page move between each other: one soft spring with almost no overshoot, the same both ways
 * (whichever end is arriving sets the timing). With reduced motion the change is instant.
 */
export function useMorphTransition(): Transition {
  return useReducedMotion() ? { duration: 0 } : { type: "spring", bounce: 0.12, duration: 0.45 };
}

/**
 * A post in the grid: its picture, who sent it and when, the title in two lines, and where it stands (the
 * compact card's status mark: "Done", "1 of 2 answered", or the solid "Needs you"). `status` is postStatus's word.
 */
export function PostTile({ entry, page, author, agentKey, status, onOpen }: {
  entry: HomeFeedEntry; page: LabPage; author: string; agentKey: string; status?: string; onOpen: () => void;
}) {
  const card = entry.state.card;
  const id = postMorphId(entry);
  const transition = useMorphTransition();
  const films = page.questions.some((question) => question.media?.some((media) => media.type === "video"));
  // The button only presses and takes focus; the surface inside it is what grows into the page. Motion moves the
  // surface with transforms, so keeping it off the button leaves the press and the focus ring to plain CSS.
  return <button type="button" onClick={onOpen} aria-haspopup="dialog"
    className="group block h-full w-full min-w-0 rounded-2xl text-left transition-transform duration-150 ease-smooth active:scale-[.985] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background motion-reduce:transition-none motion-reduce:active:scale-100">
    {/* Motion keeps corners round while it scales only when the radius is in `style`. */}
    <motion.span layoutId={id} transition={transition} style={{ borderRadius: 16 }}
      className="flex h-full min-w-0 flex-col overflow-hidden border border-border bg-card text-card-foreground transition-colors fine:group-hover:border-foreground/20">
      <motion.span layoutId={morphImageId(id)} transition={transition} style={{ borderRadius: 0 }} className="relative block aspect-[4/3] w-full shrink-0 overflow-hidden bg-muted">
        <img src={page.image} alt="" loading="lazy" className="absolute inset-0 size-full object-cover" />
        {films && <span aria-hidden className="absolute bottom-1.5 left-1.5 flex size-6 items-center justify-center rounded-full bg-black/60 text-white"><PlayIcon className="size-3" /></span>}
      </motion.span>
      {/* "position" only: the words move with the tile but are never stretched by it. */}
      <motion.span layout="position" transition={transition} className="flex min-w-0 flex-1 flex-col gap-1.5 p-2.5">
        <span className="flex h-5 min-w-0 items-center gap-1.5 text-meta text-muted-foreground [&_[data-agent-mark]]:size-5 [&_[data-agent-mark]]:text-[10px]">
          <AgentMark agentKey={agentKey} name={author} small />
          <span className="min-w-0 truncate font-semibold text-foreground">{author}</span>
          <ShortTime at={card.createdAt} className="shrink-0 tabular-nums before:mr-1.5 before:content-['·']" />
        </span>
        <motion.span layoutId={morphTitleId(id)} layout="position" transition={transition}
          className={`line-clamp-2 break-words text-sm leading-[18px] ${status === "Needs you" ? "font-semibold" : "font-medium"}`}>{card.title}</motion.span>
        {/* The status stays behind when the tile opens: shared, it crossed the title mid-morph (picks §2). */}
        <span className="mt-auto flex min-h-5 items-center pt-0.5"><StatusMark status={status} /></span>
      </motion.span>
    </motion.span>
  </button>;
}
