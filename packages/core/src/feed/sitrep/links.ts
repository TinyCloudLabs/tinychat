// Turns the references officers write into links Sam can click: Linear issues (TC-950), GitHub PRs
// and issues (TinyCloudLabs/js-sdk#505, js-sdk#505, or #505 when the item names its repo), and full
// github.com / linear.app URLs shown as short labels. Shared by the page and by roci-board's warnings.
import { LINEAR_TEAM_KEYS, findSecrets, isLinearTeamKey } from "./guard";
import { KNOWN_REPOS } from "./known-repos";

export type LinkKind = "linear" | "github" | "url";
export type TextPart = { text: string } | { href: string; label: string; kind: LinkKind };

const LINEAR_BASE = "https://linear.app/tinycloud-labs/issue/";

/** "js-sdk" → "TinyCloudLabs/js-sdk"; "owner/repo" stays; unknown short names → null. */
export function resolveRepo(repo: string | undefined): string | null {
  if (!repo) return null;
  const trimmed = repo.trim();
  if (trimmed.includes("/")) return trimmed;
  return KNOWN_REPOS[trimmed.toLowerCase()] ?? null;
}

const githubUrl = (fullRepo: string, number: string) => `https://github.com/${fullRepo}/pull/${number}`;

// Order matters: full URLs first, then owner/repo#n, then name#n, then bare #n, then KEY-n: a Linear
// issue when KEY is in LINEAR_TEAM_KEYS (TC-950, OPS-10); any other KEY-n, such as SHA-256, stays text.
const TOKEN = new RegExp(
  [
    String.raw`(?<url>https?:\/\/[^\s<>()"'\]]+[^\s<>()"'\].,;:!?])`,
    String.raw`(?<full>\b[A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*#\d{1,7}\b)`,
    String.raw`(?<short>\b[A-Za-z0-9][\w.-]*#\d{1,7}\b)`,
    String.raw`(?<bare>(?<![\w&#])#\d{1,7}\b)`,
    String.raw`(?<linear>\b[A-Z]{2,5}-\d{1,6}\b)`,
  ].join("|"),
  "g",
);
/** "TC-" or "OPS-x" with no number: meant as an issue, will not link. */
const UNNUMBERED_ISSUE = new RegExp(String.raw`\b(?:${LINEAR_TEAM_KEYS.join("|")})-(?!\d)\S*`, "g");

function shortUrlLabel(url: URL): { label: string; kind: LinkKind } {
  const github = /^\/([^/]+)\/([^/]+)\/(?:pull|issues)\/(\d+)/.exec(url.pathname);
  if (url.hostname === "github.com" && github) return { label: `${github[2]}#${github[3]}`, kind: "github" };
  const linear = /\/issue\/([A-Za-z]+-\d+)/.exec(url.pathname);
  if (url.hostname === "linear.app" && linear) return { label: linear[1]!.toUpperCase(), kind: "linear" };
  const path = url.pathname === "/" ? "" : url.pathname.replace(/\/$/, "");
  const label = `${url.hostname.replace(/^www\./, "")}${path}`;
  return { label: label.length > 42 ? `${label.slice(0, 40)}…` : label, kind: "url" };
}

/** Splits text into plain runs and links. `repo` is the item's repo, for bare #123. */
export function linkify(text: string, repo?: string): TextPart[] {
  const parts: TextPart[] = [];
  const itemRepo = resolveRepo(repo);
  let last = 0;
  const push = (part: TextPart) => {
    const prev = parts.at(-1);
    if ("text" in part && prev && "text" in prev) prev.text += part.text;
    else parts.push(part);
  };
  for (const match of text.matchAll(TOKEN)) {
    const start = match.index ?? 0;
    const token = match[0];
    const groups = match.groups ?? {};
    let link: TextPart | null = null;
    if (groups.url) {
      try {
        const url = new URL(token);
        if (!findSecrets(token).length) link = { href: url.href, ...shortUrlLabel(url) };
      } catch {
        link = null;
      }
    } else if (groups.full) {
      const [, owner, name, number] = /^([^/]+)\/([^#]+)#(\d+)$/.exec(token)!;
      link = { href: githubUrl(`${owner}/${name}`, number!), label: `${name}#${number}`, kind: "github" };
    } else if (groups.short) {
      const [, name, number] = /^(.+)#(\d+)$/.exec(token)!;
      const full = resolveRepo(name);
      if (full) link = { href: githubUrl(full, number!), label: token, kind: "github" };
    } else if (groups.bare) {
      if (itemRepo) link = { href: githubUrl(itemRepo, token.slice(1)), label: token, kind: "github" };
    } else if (groups.linear) {
      if (isLinearTeamKey(token.slice(0, token.indexOf("-")))) link = { href: `${LINEAR_BASE}${token}`, label: token, kind: "linear" };
    }
    if (!link) continue;
    if (start > last) push({ text: text.slice(last, start) });
    push(link);
    last = start + token.length;
  }
  if (last < text.length) push({ text: text.slice(last) });
  return parts;
}

/** References in the text that will not become links: unknown short repo names, or bare #123 with no repo. */
export function unresolvedRefs(text: string, repo?: string): string[] {
  const out = new Set<string>();
  const itemRepo = resolveRepo(repo);
  for (const match of text.matchAll(TOKEN)) {
    const groups = match.groups ?? {};
    if (groups.short && !resolveRepo(match[0].split("#")[0])) out.add(match[0]);
    if ((groups.bare) && !itemRepo) out.add(match[0]);
  }
  for (const match of text.matchAll(UNNUMBERED_ISSUE)) out.add(match[0]);
  return [...out];
}

/** A known-facts line with a number but nothing to check it against. */
export function unsourcedNumber(line: string, repo?: string): boolean {
  if (!/\d/.test(line)) return false;
  if (linkify(line, repo).some((part) => "href" in part)) return false;
  return !/\b(?:source|according to|measured|see)\b/i.test(line);
}

/**
 * The host the sitrep and its briefs are served from. The app build reads VITE_BRIEF_HOST; build:public
 * sets it empty so the public bundle names no tailnet host. build:cli defines it undefined, so the CLI keeps the tailnet default.
 */
export const BRIEF_HOST = "lightning-node-1.gecko-snares.ts.net";
const BRIEF_LABEL = /^(?:brief|steps)$/i;

/** A link labelled Brief or Steps: the instructions Sam needs, shown up front on a card. */
export const isGuideLink = (link: { label: string }): boolean => BRIEF_LABEL.test(link.label.trim());

/** On the public build, a link to a tailnet host (`*.<tailnet>.ts.net`), which only answers on the tailnet. The link is left as it is; the page only says so beside it. Read at call time so other builds drop it. */
export function isTailnetOnlyLink(url: string, publicBuild = false): boolean {
  if (!publicBuild) return false;
  try {
    return /\.ts\.net$/i.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** "modal": a brief on the sitrep's own host, the only host the in-app viewer frames. Everything else, a Brief/Steps label on another host included, opens in a new tab. */
export function classifyLink(link: { label: string; url: string }): "modal" | "external" {
  try {
    const url = new URL(link.url);
    return url.protocol === "https:" && url.hostname === BRIEF_HOST ? "modal" : "external";
  } catch {
    return "external";
  }
}

/** The pill's visible text. An external link names its host, so a custom label can't hide where it goes. */
export function linkCaption(link: { label: string; url: string }): string {
  if (classifyLink(link) === "modal") return link.label;
  let host: string;
  try {
    host = new URL(link.url).hostname.replace(/^www\./, "");
  } catch {
    return link.label;
  }
  return link.label.includes(host) ? link.label : `${link.label} · ${host}`;
}

/**
 * New writes only: a Brief or Steps link must be a full https:// URL, because Sam opens it from a
 * card and a bare path ("lightning-node-1 /db-options/…") is unreachable. Existing cards are not re-checked.
 */
export function briefLinkErrors(links: unknown): string[] {
  if (!Array.isArray(links)) return [];
  const errors: string[] = [];
  for (const link of links) {
    if (!link || typeof link !== "object") continue;
    const { label, url } = link as { label?: unknown; url?: unknown };
    if (typeof label !== "string" || !BRIEF_LABEL.test(label.trim())) continue;
    if (typeof url === "string" && /^https:\/\/[^\s/]+/i.test(url.trim())) continue;
    errors.push(`links: the ${label.trim()} link must be a full https:// URL, not ${JSON.stringify(url)}. Write it as --link "${label.trim()}=https://${BRIEF_HOST}/db-options/briefs/<name>/"`);
  }
  return errors;
}

/** A secret request has to tell Sam what to do: numbered steps on the card, or a Steps link. */
export function hasSteps(record: { steps?: unknown; links?: unknown }): boolean {
  if (Array.isArray(record.steps) && record.steps.length > 0) return true;
  return Array.isArray(record.links) && record.links.some((link) => link && typeof link === "object" && typeof (link as { label?: unknown }).label === "string" && /^steps$/i.test(((link as { label: string }).label).trim()));
}

/** Text that names the brief host and a path with no scheme ("lightning-node-1 /db-options/…"): unreachable as written. */
export function schemelessBriefPaths(text: string): string[] {
  return [...text.matchAll(/(?<!\/\/)\blightning-node-1(?:\.gecko-snares\.ts\.net)?\s*\/[\w.-]+[^\s]*/g)].map((match) => match[0]);
}

/** A markdown link target as an absolute http(s) URL, or null. With a base, relative paths and #fragments resolve against it; without one only an absolute http(s) target counts. Any other scheme (javascript:, data:, …) is refused. */
export function resolveLinkTarget(target: string, base?: string): string | null {
  const trimmed = target.trim();
  if (!trimmed || /\s/.test(trimmed)) return null;
  if (!base && !/^https?:\/\//i.test(trimmed)) return null;
  try {
    const url = new URL(trimmed, base);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

/** A link the brief modal swaps to in place: same host as the brief being read, path ending .md (any #fragment). */
export function isSameOriginMarkdown(url: string, current: string): boolean {
  try {
    const next = new URL(url);
    return (next.protocol === "http:" || next.protocol === "https:") && next.host === new URL(current).host && /\.md$/i.test(next.pathname);
  } catch {
    return false;
  }
}
