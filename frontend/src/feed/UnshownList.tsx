// "Not shown on the card" (the design agent's details/ mock, after Sam: "details to indicate the unrendered content"):
// every part of the card's data its open card does not draw, path first, value exactly as sent. Values are only ever
// text: a link is not opened and an image is not loaded (loading one would tell the other site the owner's address).
import { useLayoutEffect, useRef, useState } from "react";
import { formHint, type UnshownField } from "./unshown";

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

/** The fields the card does not draw, one row each; `agent` names who sent them. Nothing when every field is drawn. */
export function UnshownList({ fields, agent }: { fields: readonly UnshownField[]; agent: string }) {
  if (!fields.length) return null;
  return <section aria-label="Not shown on the card">
    <h3 className={sectionTitle}>Not shown on the card <b className="font-semibold text-foreground">{fields.length}</b></h3>
    <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
      {fields.map((field) => <li key={field.path} className="grid gap-[3px] px-3 py-2.5">
        <span className="flex items-center gap-2"><code className="font-semibold text-foreground [overflow-wrap:anywhere]">{field.path.split(".").map((part, index) => <span key={index}>{index > 0 && <>.<wbr /></>}{part}</span>)}</code><small className="ml-auto shrink-0 text-[11px] text-muted-foreground">{formHint(field.value)}</small></span>
        {typeof field.value === "object" && field.value !== null
          ? <JsonValue value={field.value} />
          : <span className="whitespace-pre-wrap text-[13px] leading-[18px] [overflow-wrap:anywhere]">{String(field.value)}</span>}
      </li>)}
    </ul>
    <p className="mt-2 text-xs leading-[17px] text-muted-foreground">These fields are shown exactly as {agent} sent them. Links aren't opened and images aren't loaded.</p>
  </section>;
}

/** The whole card as it was sent, as JSON, folded into one row: the fallback that leaves nothing out. */
export function CardData({ card }: { card: unknown }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const json = JSON.stringify(card, null, 2);
  async function copy() {
    try { await navigator.clipboard.writeText(json); setCopied(true); } catch { setCopied(false); }
  }
  return <section aria-label="Card data" className="rounded-xl border border-border bg-card text-[13px]">
    <div className="flex min-h-10 items-center gap-2 px-3">
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="min-h-10 flex-1 text-left">Card data</button>
      <span className="text-xs text-muted-foreground">JSON</span><span aria-hidden className="text-xs text-muted-foreground">·</span>
      <button type="button" onClick={() => void copy()} className="min-h-10 text-xs text-muted-foreground underline decoration-border underline-offset-[3px]">{copied ? "Copied" : "Copy"}</button>
    </div>
    {open && <pre className="max-h-80 overflow-auto whitespace-pre-wrap border-t border-border px-3 py-2 text-xs [overflow-wrap:anywhere]">{json}</pre>}
  </section>;
}

export const detailsSectionTitle = sectionTitle;
