// A brief's Markdown, rendered as React elements (BriefSheet.tsx). It is a small reader, not a full CommonMark
// engine: headings, paragraphs, lists (nested by indent), quotes, code, rules, pipe tables, and inline bold,
// italics, strikethrough, code and links. Nothing is ever injected as HTML: raw HTML in the text shows as text, and
// images show their alt text, so an agent's brief can't run script or load anything. The repo's other renderers
// don't fit: the assistant-ui one needs a chat message around it, and franken-markdown is 7.7 MB of WASM that
// returns HTML.
import type { ReactNode } from "react";

export type BriefBlock =
  | { kind: "heading"; level: number; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "list"; ordered: boolean; start: number; items: BriefBlock[][] }
  | { kind: "quote"; blocks: BriefBlock[] }
  | { kind: "code"; text: string }
  | { kind: "rule" }
  | { kind: "table"; head: string[]; rows: string[][] };

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}>/;
const ITEM = /^( *)([-*+]|(\d{1,9})[.)])(?:[ \t]+(.*))?$/;
const TABLE_DIVIDER = /^ *\|? *:?-+:? *(?:\| *:?-+:? *)*\|? *$/;

function listItem(line: string) {
  const match = ITEM.exec(line);
  if (!match) return undefined;
  const indent = match[1]!.length;
  // Where the item's own text starts: later lines indented this far belong to the item.
  const offset = indent + match[2]!.length + 1;
  return { indent, offset, ordered: match[3] !== undefined, start: Number(match[3] ?? 1), text: match[4] ?? "" };
}

const startsBlock = (line: string) => FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line) || !!listItem(line);
const leading = (line: string) => line.length - line.trimStart().length;

function cells(line: string): string[] {
  let row = line.trim();
  if (row.startsWith("|")) row = row.slice(1);
  if (row.endsWith("|") && !row.endsWith("\\|")) row = row.slice(0, -1);
  const out: string[] = [];
  let cell = "";
  for (let index = 0; index < row.length; index++) {
    if (row[index] === "\\" && row[index + 1] === "|") { cell += "|"; index++; continue; }
    if (row[index] === "|") { out.push(cell.trim()); cell = ""; continue; }
    cell += row[index];
  }
  out.push(cell.trim());
  return out;
}

/** Splits Markdown into blocks. Exported for tests. */
export function parseBriefBlocks(markdown: string): BriefBlock[] {
  const lines = markdown.replace(/\r\n?/g, "\n").replace(/\t/g, "    ").split("\n");
  const blocks: BriefBlock[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    if (!line.trim()) { index++; continue; }

    const fence = FENCE.exec(line);
    if (fence) {
      const body: string[] = [];
      index++;
      while (index < lines.length && !lines[index]!.trimStart().startsWith(fence[1]!)) body.push(lines[index++]!);
      index++;
      blocks.push({ kind: "code", text: body.join("\n") });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({ kind: "heading", level: heading[1]!.length, text: heading[2]! });
      index++;
      continue;
    }

    // Before lists, so "- - -" and "* * *" are rules.
    if (RULE.test(line)) {
      blocks.push({ kind: "rule" });
      index++;
      continue;
    }

    if (QUOTE.test(line)) {
      const inner: string[] = [];
      while (index < lines.length && QUOTE.test(lines[index]!)) inner.push(lines[index++]!.replace(/^ {0,3}> ?/, ""));
      blocks.push({ kind: "quote", blocks: parseBriefBlocks(inner.join("\n")) });
      continue;
    }

    const first = listItem(line);
    if (first) {
      const items: string[][] = [[first.text]];
      // Lines indented two or more past this list's markers belong to the current item (its own nested list too).
      const inside = first.indent + 2;
      index++;
      while (index < lines.length) {
        const next = lines[index]!;
        if (!next.trim()) {
          // A blank line ends the list unless the list, or the current item, carries on after it.
          let ahead = index;
          while (ahead < lines.length && !lines[ahead]!.trim()) ahead++;
          const resumed = ahead < lines.length ? lines[ahead]! : "";
          const sibling = listItem(resumed);
          const carriesOn = (sibling && sibling.indent < inside && sibling.ordered === first.ordered) || (resumed && leading(resumed) >= inside);
          if (!carriesOn) break;
          items.at(-1)!.push("");
          index = ahead;
          continue;
        }
        const item = listItem(next);
        if (item && item.indent < inside) {
          if (item.ordered !== first.ordered) break;
          items.push([item.text]);
        } else if (leading(next) >= inside) {
          items.at(-1)!.push(next.slice(Math.min(first.offset, leading(next))));
        } else if (startsBlock(next)) {
          break;
        } else {
          // A lazy line: it carries on the item's paragraph.
          items.at(-1)!.push(next.trimStart());
        }
        index++;
      }
      blocks.push({ kind: "list", ordered: first.ordered, start: first.start, items: items.map((item) => parseBriefBlocks(item.join("\n"))) });
      continue;
    }

    if (line.includes("|") && index + 1 < lines.length && TABLE_DIVIDER.test(lines[index + 1]!) && lines[index + 1]!.includes("-")) {
      const head = cells(line);
      const rows: string[][] = [];
      index += 2;
      while (index < lines.length && lines[index]!.trim() && lines[index]!.includes("|")) rows.push(cells(lines[index++]!));
      blocks.push({ kind: "table", head, rows });
      continue;
    }

    const paragraph: string[] = [line.trim()];
    index++;
    while (index < lines.length && lines[index]!.trim() && !startsBlock(lines[index]!)) paragraph.push(lines[index++]!.trim());
    blocks.push({ kind: "paragraph", text: paragraph.join(" ") });
  }
  return blocks;
}

/**
 * Where a link in the brief goes: an http(s) or mailto address, a relative one resolved against the brief's own
 * address. Anything else (javascript:, data:, a #fragment the sheet has no target for) stays plain text.
 */
function linkTarget(href: string, base: string | undefined): string | undefined {
  if (href.startsWith("#")) return undefined;
  try {
    const url = base ? new URL(href, base) : new URL(href);
    return ["https:", "http:", "mailto:"].includes(url.protocol) ? url.href : undefined;
  } catch {
    return undefined;
  }
}

const linkClass = "font-medium text-foreground underline decoration-muted-foreground/50 underline-offset-2 transition-colors hover:decoration-foreground focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

function Link({ href, base, children }: { href: string; base: string | undefined; children: ReactNode }) {
  const target = linkTarget(href, base);
  // Links leave the sheet for a new tab, so the decision being made stays where it is.
  return target ? <a href={target} target="_blank" rel="noopener noreferrer" className={linkClass}>{children}</a> : <>{children}</>;
}

// One pass over a line of text. Order matters: code first (nothing inside it is Markdown), images before links.
const INLINE = /`([^`]+)`|!\[([^\]]*)\]\([^)]*\)|\[([^\]]+)\]\(<?([^()\s>]+)>?(?:\s+"[^"]*")?\)|<((?:https?:\/\/|mailto:)[^\s>]+)>|(https?:\/\/[^\s<>()]*[^\s<>().,;:!?'"])|\*\*(.+?)\*\*|__(.+?)__|~~(.+?)~~|\*([^*\s](?:[^*]*[^*\s])?)\*|_([^_\s](?:[^_]*[^_\s])?)_|\\([\\`*_{}[\]()#+\-.!|>~])/g;
const wordChar = /[\p{L}\p{N}]/u;

/** A line of brief text with its inline Markdown. `base` resolves relative links. */
export function BriefInline({ text, base }: { text: string; base?: string }) {
  const out: ReactNode[] = [];
  // Its own copy, since a global pattern keeps its place and this recurses into bold, links and the rest.
  const pattern = new RegExp(INLINE.source, "g");
  let plain = "";
  let last = 0;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    const [whole, code, alt, label, href, angled, bare, strong, strongUnder, struck, em, emUnder, escaped] = match;
    // Underscores inside a word (snake_case) are not emphasis.
    if ((strongUnder !== undefined || emUnder !== undefined) && (wordChar.test(text[match.index - 1] ?? "") || wordChar.test(text[match.index + whole.length] ?? ""))) {
      pattern.lastIndex = match.index + 1;
      continue;
    }
    plain += text.slice(last, match.index);
    last = match.index + whole.length;
    if (escaped !== undefined) { plain += escaped; continue; }
    if (plain) { out.push(plain); plain = ""; }
    const key = out.length;
    if (code !== undefined) out.push(<code key={key} className="rounded bg-surface-2 px-1 py-0.5 font-mono text-[0.875em]">{code}</code>);
    else if (alt !== undefined) out.push(alt ? <span key={key} className="text-muted-foreground">[{alt}]</span> : null);
    else if (label !== undefined) out.push(<Link key={key} href={href!} base={base}><BriefInline text={label} base={base} /></Link>);
    else if (angled !== undefined || bare !== undefined) out.push(<Link key={key} href={(angled ?? bare)!} base={base}>{(angled ?? bare)!.replace(/^mailto:/, "")}</Link>);
    else if (strong !== undefined || strongUnder !== undefined) out.push(<strong key={key} className="font-semibold"><BriefInline text={(strong ?? strongUnder)!} base={base} /></strong>);
    else if (struck !== undefined) out.push(<s key={key}><BriefInline text={struck} base={base} /></s>);
    else out.push(<em key={key}><BriefInline text={(em ?? emUnder)!} base={base} /></em>);
  }
  plain += text.slice(last);
  if (plain) out.push(plain);
  return <>{out}</>;
}

function Blocks({ blocks, base, tight = false }: { blocks: BriefBlock[]; base?: string; tight?: boolean }) {
  return <>{blocks.map((block, index) => {
    switch (block.kind) {
      case "heading": {
        // The sheet's title is the page's h2, so the brief's own headings sit under it.
        const Tag = block.level <= 2 ? "h3" : "h4";
        return <Tag key={index} className={block.level <= 2 ? "mt-6 text-headline first:mt-0" : "mt-5 text-callout font-semibold first:mt-0"}><BriefInline text={block.text} base={base} /></Tag>;
      }
      case "paragraph":
        // A tight list item's text is not a separate paragraph, so it gets no gap of its own.
        return tight ? <span key={index}><BriefInline text={block.text} base={base} /></span> : <p key={index} className="mt-3 first:mt-0"><BriefInline text={block.text} base={base} /></p>;
      case "list": {
        const items = block.items.map((item, itemIndex) => {
          const single = item.length === 1 && item[0]!.kind === "paragraph";
          return <li key={itemIndex} className="mt-1.5 pl-1 first:mt-0"><Blocks blocks={item} base={base} tight={single} /></li>;
        });
        const listClass = "mt-3 pl-6 first:mt-0 [&_ol]:mt-1.5 [&_ul]:mt-1.5";
        return block.ordered
          ? <ol key={index} start={block.start === 1 ? undefined : block.start} className={`${listClass} list-decimal marker:text-muted-foreground`}>{items}</ol>
          : <ul key={index} className={`${listClass} list-disc marker:text-muted-foreground`}>{items}</ul>;
      }
      case "quote":
        return <blockquote key={index} className="mt-3 border-l-2 border-border pl-4 text-muted-foreground first:mt-0"><Blocks blocks={block.blocks} base={base} /></blockquote>;
      case "code":
        return <pre key={index} className="mt-3 overflow-x-auto rounded-lg bg-surface-2 p-3 font-mono text-meta first:mt-0"><code>{block.text}</code></pre>;
      case "rule":
        return <hr key={index} className="my-6 border-border" />;
      case "table":
        return <div key={index} className="mt-3 overflow-x-auto rounded-lg border border-border first:mt-0">
          <table className="w-full border-collapse text-left text-callout">
            <thead className="bg-surface-2">
              <tr>{block.head.map((cell, cellIndex) => <th key={cellIndex} scope="col" className="px-3 py-2 align-bottom font-semibold"><BriefInline text={cell} base={base} /></th>)}</tr>
            </thead>
            <tbody>
              {block.rows.map((row, rowIndex) => <tr key={rowIndex} className="border-t border-border">
                {block.head.map((_, cellIndex) => <td key={cellIndex} className="px-3 py-2 align-top"><BriefInline text={row[cellIndex] ?? ""} base={base} /></td>)}
              </tr>)}
            </tbody>
          </table>
        </div>;
    }
  })}</>;
}

/** A brief's Markdown as readable text. `base` (the brief's own address, when it was fetched) resolves relative links. */
export function BriefMarkdown({ markdown, base }: { markdown: string; base?: string }) {
  return <div className="min-w-0 break-words text-body text-foreground"><Blocks blocks={parseBriefBlocks(markdown)} base={base} /></div>;
}
