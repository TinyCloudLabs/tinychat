// Feed lab (Sam, 11-12: "make your own"): the compact card, one component for every card in the compact view, and
// the status mark the grid's tiles share. Spec: the design agent's compact-card/SPEC.md. Three cues, none of them
// colour alone, tell a card's kind before you read it: a solid "Needs you" chip (every other status is quiet text
// with an icon; updates show none), a semibold title only on cards that need you, and a thumbnail only on posts.
import { AlarmClockIcon, CheckIcon, CircleAlertIcon, Clock3Icon, PlayIcon } from "lucide-react";

import { AgentMark, PlatformName, type Platform } from "./AgentMark";
import { ShortTime } from "./ShortTime";

/** A card's status as the compact card and the grid show it. `status` is cardStatus's word, or a post's progress. */
export function StatusMark({ status }: { status?: string }) {
  if (!status || status === "Information") return null;
  if (status === "Needs you") return <span className="inline-flex h-5 shrink-0 items-center rounded-full bg-foreground px-2 text-[11px] font-semibold text-background">Needs you</span>;
  const quiet = "inline-flex shrink-0 items-center gap-1 text-meta text-muted-foreground [&_svg]:size-3.5";
  if (status.startsWith("Waiting on")) return <span className={quiet} title={status}><Clock3Icon aria-hidden />Waiting</span>;
  if (status === "Done") return <span className={quiet}><CheckIcon aria-hidden />Done</span>;
  if (status === "Snoozed") return <span className={quiet}><AlarmClockIcon aria-hidden />Snoozed</span>;
  if (status === "Failed") return <span className={`${quiet} text-destructive`}><CircleAlertIcon aria-hidden />Failed</span>;
  return <span className={quiet}>{status}</span>;
}

export function CompactCard({ agentKey, author, platform, createdAt, status, title, description, thumb, onOpen, opensPage = false }: {
  agentKey: string; author: string; platform?: Platform; createdAt: string;
  /** cardStatus's word (or a post's progress); undefined shows none. */
  status?: string;
  title: string; description?: string;
  /** A post's page, as a 64px square; `video` adds a play badge. */
  thumb?: { src: string; video: boolean };
  onOpen: () => void;
  /** A post opens its page; every other card opens in place. */
  opensPage?: boolean;
}) {
  const needsYou = status === "Needs you";
  const textColumns = thumb ? "col-span-1" : "col-span-2";
  return <button type="button" onClick={onOpen} {...(opensPage ? { "aria-haspopup": "dialog" as const } : { "aria-expanded": false })}
    className="grid w-full min-w-0 grid-cols-[1.75rem_minmax(0,1fr)_auto] gap-x-3 rounded-2xl border border-border bg-card px-3.5 pb-[13px] pt-3 text-left text-card-foreground transition-[transform,border-color] duration-150 ease-smooth active:scale-[.985] active:bg-muted/50 fine:hover:border-foreground/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background motion-reduce:transition-none motion-reduce:active:scale-100">
    <span className="row-span-3 -mt-1"><AgentMark agentKey={agentKey} name={author} small /></span>
    <span className="col-span-2 flex h-5 min-w-0 items-center gap-1.5 text-meta text-muted-foreground">
      <span className="max-w-[58%] shrink-0 truncate font-semibold text-foreground">{author}</span>
      {platform && <span className="flex min-w-0 shrink items-center"><PlatformName platform={platform} logoOnly /></span>}
      <ShortTime at={createdAt} className="shrink-0 tabular-nums before:mr-1.5 before:content-['·']" />
      <span className="ml-auto flex shrink-0 items-center"><StatusMark status={status} /></span>
    </span>
    <span className={`${textColumns} mt-1 line-clamp-2 break-words text-[15px] leading-5 tracking-[-0.005em] ${needsYou ? "font-semibold" : "font-medium"}`}>{title}</span>
    {description && <span className={`${textColumns} mt-0.5 line-clamp-2 break-words text-sm leading-[19px] text-muted-foreground`}>{description}</span>}
    {thumb && <span className="relative col-start-3 row-span-2 row-start-2 mt-1.5 size-16 self-start overflow-hidden rounded-[10px] border border-border bg-muted">
      <img src={thumb.src} alt="" loading="lazy" className="size-full object-cover" />
      {thumb.video && <span aria-hidden className="absolute bottom-1 left-1 flex size-5 items-center justify-center rounded-full bg-black/60 text-white"><PlayIcon className="size-[11px]" /></span>}
    </span>}
  </button>;
}
