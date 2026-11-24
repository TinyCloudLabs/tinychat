// TC-3716: client-side scrubbing of what a bug report carries (the typed note and recent error messages), before it
// is signed and sent. These are the feedback Worker's own rules (tinycloud-bugs src/scrub.ts) with its identity
// rules always on, plus `sk_` API keys and TinyCloud space ids, as Bobbie's review asked (C3, C4). It does not wrap
// redactDebugText: that one cuts text at 500 characters and blanks any text that mentions a delegation or SIWE.
// The Worker scrubs again; this is the first layer, so the person's preview shows what is actually sent.
import { wordlist } from "@scure/bip39/wordlists/english";

interface Rule {
  type: string;
  re: RegExp;
  /** The part of a match to redact (needs the `d` flag); defaults to the whole match. */
  secret?: (m: RegExpExecArray) => [number, number] | null;
  accept?: (m: RegExpExecArray, input: string) => boolean;
}

interface Span { start: number; end: number; type: string; rank: number }

const firstGroup = (...groups: number[]) => (m: RegExpExecArray): [number, number] | null => {
  for (const g of groups) if (m.indices?.[g]) return m.indices[g];
  return null;
};

const SECRET_NAME =
  "[A-Za-z0-9_.-]{0,40}(?:api[ _-]?key|secret|token|passw(?:or)?d|passphrase|pass|pwd|private[ _-]?key|credential|access[ _-]?key|auth[ _-]?key)s?[A-Za-z0-9_ .-]{0,30}?";

const RULES: Rule[] = [
  // Identity first, so a DID that holds an address is named a DID.
  {
    type: "user_path",
    re: /(\/(?:home|Users)\/|[A-Za-z]:\\Users\\)([^/\\\s'"`]+)/dg,
    secret: firstGroup(2),
    accept: (m) => !/^(?:Shared|Public)$/i.test(m[2]),
  },
  { type: "did", re: /(?<![A-Za-z0-9])did:[a-z0-9]{1,16}:[A-Za-z0-9:._%-]+/g },
  { type: "space", re: /(?<![A-Za-z0-9])tinycloud:[a-z0-9]{1,16}:[A-Za-z0-9:._%-]+/g },
  { type: "address", re: /(?<![0-9a-zA-Z])0x[0-9a-fA-F]{40}(?![0-9a-zA-Z])/g },
  { type: "uuid", re: /(?<![0-9a-fA-F-])[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}(?![0-9a-fA-F-])/g },
  {
    type: "ip",
    re: /(?<![0-9.])(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)(?![0-9.])/g,
    accept: (m) => !m[0].startsWith("127.") && m[0] !== "0.0.0.0",
  },
  { type: "jwt", re: /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{2,}(?:\.[A-Za-z0-9_-]*)?/g },
  {
    type: "bearer",
    re: /(?<![A-Za-z0-9])(bearer|basic)[ \t]+([A-Za-z0-9._~+/-]{4,}=*)/dgi,
    secret: firstGroup(2),
    accept: (m) => {
      const [, scheme, credential] = m;
      if (scheme.toLowerCase() === "basic" && isBasicCredential(credential)) return true;
      return credential.length >= 8 && (/[^A-Za-z]/.test(credential) || credential.length >= 20);
    },
  },
  {
    type: "secret_assignment",
    re: new RegExp(`(?<![A-Za-z0-9])(${SECRET_NAME}["']?[ \\t]*[:=][ \\t]*)(?:"([^"\\n]*)"?|'([^'\\n]*)'?|([^\\s"',;]+))`, "dgi"),
    secret: firstGroup(2, 3, 4),
    accept: (m) => {
      const value = m[2] ?? m[3] ?? m[4];
      if (value.length < 6) return false;
      return m[4] === undefined || /[^A-Za-z]/.test(value) || value.length >= 20;
    },
  },
  // C3: ElevenLabs-style keys, which the Worker's rules let through.
  { type: "api_key", re: /(?<![A-Za-z0-9])sk_[0-9a-f]{40,}/g },
  { type: "api_key", re: /(?<![A-Za-z0-9])sk_[A-Za-z0-9]{32,}/g },
  { type: "api_key", re: /(?<![A-Za-z0-9])sk-(?:ant-|proj-|svcacct-|or-)?[A-Za-z0-9_-]{16,}/g },
  { type: "api_key", re: /(?<![A-Za-z0-9])(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{10,}/g },
  { type: "api_key", re: /(?<![A-Za-z0-9])tk_[A-Za-z0-9_-]{8,}/g },
  { type: "api_key", re: /(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g },
  { type: "api_key", re: /github_pat_[A-Za-z0-9_]{20,}/g },
  { type: "api_key", re: /(?<![A-Za-z0-9])glpat-[A-Za-z0-9_-]{20,}/g },
  { type: "api_key", re: /(?<![A-Za-z0-9])(?:xox[abposr]|xapp)-[A-Za-z0-9-]{10,}/g },
  { type: "api_key", re: /(?<![A-Za-z0-9])(?:AKIA|ASIA)[0-9A-Z]{16}(?![0-9A-Z])/g },
  { type: "api_key", re: /(?<![A-Za-z0-9])AIza[0-9A-Za-z_-]{35}/g },
  { type: "api_key", re: /(?<![A-Za-z0-9])npm_[A-Za-z0-9]{36}(?![A-Za-z0-9])/g },
  { type: "api_key", re: /(?<![A-Za-z0-9])lin_(?:api|oauth)_[A-Za-z0-9]{20,}/g },
  { type: "api_key", re: /(?<![A-Za-z0-9])whsec_[A-Za-z0-9+/=]{20,}/g },
  {
    type: "email",
    re: /(?<![\p{L}\p{N}._%+-])(?:"[^"\n]{1,64}"|[\p{L}\p{N}._%+-]{1,64})@[\p{L}\p{N}-]{1,63}(?:\.[\p{L}\p{N}-]{1,63}){0,8}\.\p{L}{2,24}(?![\p{L}\p{N}])/gu,
  },
  { type: "hex_key", re: /(?<![0-9a-fA-F])(?:0x)?[0-9a-fA-F]{64,}(?![0-9a-fA-F])/g },
  {
    type: "high_entropy",
    re: /[A-Za-z0-9+/_-]{32,}={0,2}/g,
    accept: (m) => /[A-Z]/.test(m[0]) && /[a-z]/.test(m[0]) && /[0-9]/.test(m[0]) && shannon(m[0]) >= 4.3,
  },
];

function isBasicCredential(value: string): boolean {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) return false;
  try {
    return /^[\x20-\x7e]*:[\x20-\x7e]*$/.test(atob(value));
  } catch {
    return false;
  }
}

function shannon(s: string): number {
  const counts = new Map<string, number>();
  for (const c of s) counts.set(c, (counts.get(c) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

// PEM private keys by forward scan (linear on a paste of many BEGIN lines without END).
const PEM_BEGIN = /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY-----/g;
const PEM_END = /-----END [A-Z0-9 ]{0,40}PRIVATE KEY-----/g;
const PEM_TAIL = /(?:[ \t]*\r?\n|[A-Za-z-]{1,40}:[^\n]{0,200}\n|[A-Za-z0-9+/=]{1,128})*/y;

function pemSpans(input: string, spans: Span[]): void {
  let end: RegExpExecArray | null | undefined;
  PEM_BEGIN.lastIndex = 0;
  for (let begin = PEM_BEGIN.exec(input); begin; begin = PEM_BEGIN.exec(input)) {
    if (end !== null && (end === undefined || end.index < begin.index)) {
      PEM_END.lastIndex = begin.index;
      end = PEM_END.exec(input);
    }
    let stop: number;
    if (end) {
      stop = end.index + end[0].length;
    } else {
      PEM_TAIL.lastIndex = begin.index + begin[0].length;
      PEM_TAIL.exec(input);
      stop = PEM_TAIL.lastIndex;
    }
    spans.push({ start: begin.index, end: stop, type: "private_key", rank: -2 });
    PEM_BEGIN.lastIndex = stop;
  }
}

// Runs of 12+ BIP39 words, optionally numbered.
const BIP39 = new Set(wordlist);
const WORD = /[A-Za-z]+/g;
const SEED_GAP = /^[\s,;]*(?:\d{1,2}[.):]?[\s,;]*)?$/;

function seedSpans(input: string, spans: Span[]): void {
  let runStart = -1;
  let runEnd = -1;
  let words = 0;
  const close = () => {
    if (words >= 12) spans.push({ start: runStart, end: runEnd, type: "seed_phrase", rank: -1 });
    words = 0;
  };
  WORD.lastIndex = 0;
  for (let m = WORD.exec(input); m; m = WORD.exec(input)) {
    const isSeedWord = m[0].length <= 8 && BIP39.has(m[0].toLowerCase());
    if (isSeedWord && words > 0 && SEED_GAP.test(input.slice(runEnd, m.index))) {
      runEnd = m.index + m[0].length;
      words++;
      continue;
    }
    close();
    if (isSeedWord) {
      runStart = m.index;
      runEnd = m.index + m[0].length;
      words = 1;
    }
  }
  close();
}

/** `text` with identifiers and likely secrets replaced by `[REDACTED:<type>]`. */
export function redactForReport(input: string): string {
  const spans: Span[] = [];
  pemSpans(input, spans);
  seedSpans(input, spans);
  RULES.forEach((rule, rank) => {
    for (const m of input.matchAll(rule.re)) {
      if (rule.accept && !rule.accept(m, input)) continue;
      const range = rule.secret ? rule.secret(m) : [m.index, m.index + m[0].length];
      if (range && range[1] > range[0]) spans.push({ start: range[0], end: range[1], type: rule.type, rank });
    }
  });
  if (spans.length === 0) return input;
  // Overlapping or touching spans merge into one tag, named by the first.
  spans.sort((a, b) => a.start - b.start || b.end - a.end || a.rank - b.rank);
  let out = "";
  let pos = 0;
  let i = 0;
  while (i < spans.length) {
    const first = spans[i];
    let end = first.end;
    for (i++; i < spans.length && spans[i].start <= end; i++) end = Math.max(end, spans[i].end);
    out += `${input.slice(pos, first.start)}[REDACTED:${first.type}]`;
    pos = end;
  }
  return out + input.slice(pos);
}
