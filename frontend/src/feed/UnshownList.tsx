// "Not shown on the card" (the design agent's details/ mock, after Sam: "details to indicate the unrendered content"):
// every part of the card's data its open card does not draw, by its name in plain words (the path in small type under
// it), value exactly as sent. Values are only ever text: a link is not opened and an image is not loaded (loading one
// would tell the other site the owner's address).
import { useLayoutEffect, useRef, useState } from "react";
import { ChevronDownIcon } from "lucide-react";
import { shortTime } from "./ShortTime";
import { fieldLabel, formHint, type UnshownField } from "./unshown";

const sectionTitle = "mb-2 flex items-baseline gap-1.5 text-xs font-semibold uppercase tracking-[.04em] text-muted-foreground";
const reveal = "inline-flex min-h-8 items-center text-xs font-medium text-muted-foreground underline decoration-border underline-offset-[3px]";

/** A long value cut to a few lines, with "Show all" when it is. */
function JsonValue({ value }: { value: unknown }) {
  const [all, setAll] = useState(false);
  const [cut, setCut] = useState(false);
  const pre = useRef<HTMLPreElement>(null);
  useLayoutEffect(() => { const node = pre.current; if (node && !all) setCut(node.scrollHeight > node.clientHeight + 1); }, [all, value]);
  return <>
    <pre ref={pre} className={`mt-0.5 whitespace-pre-wrap rounded-lg bg-muted px-2.5 py-2 text-xs [overflow-wrap:anywhere] ${all ? "" : "max-h-[9.5em] overflow-hidden"}`}>{JSON.stringify(value, null, 2)}</pre>
    {cut && !all && <button type="button" className={reveal} onClick={() => setAll(true)}>Show all</button>}
  </>;
}

const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

/** One field: its name in plain words (a number or yes/no beside it), its path in small type, then its value. */
function FieldRow({ field }: { field: UnshownField }) {
  const scalar = typeof field.value === "number" || typeof field.value === "boolean";
  const time = typeof field.value === "string" && ISO_TIME.test(field.value) && !Number.isNaN(Date.parse(field.value));
  const shown = typeof field.value === "boolean" ? (field.value ? "Yes" : "No") : String(field.value);
  return <li className="grid gap-[3px] px-3 py-2.5">
    <span className="flex items-baseline gap-2"><span className="font-semibold text-foreground">{fieldLabel(field.path)}{scalar && ` ${shown}`}</span>
      {!scalar && !time && <small className="ml-auto shrink-0 text-[11px] text-muted-foreground">{formHint(field.value)}</small>}</span>
    <code className="text-[11px] text-muted-foreground">{field.path.split(".").map((part, index) => <span key={index}>{index > 0 && <>.<wbr /></>}{part}</span>)}</code>
    {scalar ? null : time
      ? <time dateTime={shown} title={shown} className="text-[13px] leading-[18px]">{shortTime(shown)}</time>
      : typeof field.value === "object" && field.value !== null
        ? <JsonValue value={field.value} />
        : <span className="whitespace-pre-wrap text-[13px] leading-[18px]">{shown}</span>}
  </li>;
}

const rows = "divide-y divide-border overflow-hidden rounded-xl border border-border bg-card";

/**
 * The fields the card does not draw, one row each; `agent` names who sent them. Bookkeeping the feed uses but does not
 * draw (`quiet`) is listed under it, folded, and not counted. Nothing when every field is drawn.
 */
export function UnshownList({ fields, agent }: { fields: readonly UnshownField[]; agent: string }) {
  const [quietOpen, setQuietOpen] = useState(false);
  const loud = fields.filter((field) => !field.quiet);
  const quiet = fields.filter((field) => field.quiet);
  if (!fields.length) return null;
  return <div className="grid gap-[18px]">
    {loud.length > 0 && <section aria-label="Not shown on the card">
      <h3 className={sectionTitle}>Not shown on the card <b className="font-semibold text-foreground">{loud.length}</b></h3>
      <ul className={rows}>{loud.map((field) => <FieldRow key={field.path} field={field} />)}</ul>
      <p className="mt-2 text-xs leading-[17px] text-muted-foreground">These fields are shown exactly as {agent} sent them. Links aren't opened and images aren't loaded.</p>
    </section>}
    {quiet.length > 0 && <section aria-label="Used by the feed">
      <h3 className="m-0"><button type="button" aria-expanded={quietOpen} onClick={() => setQuietOpen(!quietOpen)} className={`${sectionTitle} mb-0 min-h-8 w-full`}>
        Used by the feed <b className="font-semibold text-foreground">{quiet.length}</b>
        <ChevronDownIcon aria-hidden className={`ml-auto size-4 transition-transform motion-reduce:transition-none ${quietOpen ? "rotate-180" : ""}`} />
      </button></h3>
      {quietOpen && <ul className={`mt-2 ${rows}`}>{quiet.map((field) => <FieldRow key={field.path} field={field} />)}</ul>}
    </section>}
  </div>;
}

/** The whole card as it was sent, as JSON, folded into one row: the fallback that leaves nothing out. */
export function CardData({ card }: { card: unknown }) {
  const [open, setOpen] = useState(false);
  return <section aria-label="Card data" className="rounded-xl border border-border bg-card text-[13px]">
    <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="flex min-h-10 w-full items-center gap-2 px-3 text-left">
      <span className="flex-1">Card data</span><span className="text-xs text-muted-foreground">JSON</span>
    </button>
    {open && <pre className="max-h-80 overflow-auto whitespace-pre-wrap border-t border-border px-3 py-2 text-xs">{JSON.stringify(card, null, 2)}</pre>}
  </section>;
}

export const detailsSectionTitle = sectionTitle;
