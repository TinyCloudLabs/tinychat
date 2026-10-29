// Two text rules every board record follows: nothing that looks like a secret or an approval/OAuth
// link may be posted, and every Linear issue number (TC-123) gets its link (Sam: "when u tell me
// numbers you have to give me links or context"). The one exception to the first rule is the `url`
// of an approval record, and only for an allowlisted consent page (approvalUrlKind).

export interface SecretFinding {
  /** Dotted path of the offending field, e.g. "links.0.url". */
  path: string;
  /** What it looked like. Never the value itself. */
  reason: string;
}

const PATTERNS: ReadonlyArray<[reason: string, pattern: RegExp]> = [
  ["a JWT", /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,}/],
  ["a private key block", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["an API key (sk-…)", /\bsk-(?:ant-|proj-|live-)?[A-Za-z0-9_-]{16,}/],
  ["a Stripe key", /\b[rsp]k_(?:live|test)_[A-Za-z0-9]{16,}/],
  ["a GitHub token", /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/],
  ["a Slack token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ["an AWS access key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ["a Google API key", /\bAIza[0-9A-Za-z_-]{35}/],
  ["a Linear API key", /\blin_(?:api|oauth)_[A-Za-z0-9]{20,}/],
  ["a GitLab token", /\bglpat-[A-Za-z0-9_-]{20,}/],
  ["an npm token", /\bnpm_[A-Za-z0-9]{30,}/],
  ["a Tailscale key", /\btskey-[A-Za-z0-9-]{10,}/],
  ["a hex private key", /\b0x[0-9a-fA-F]{64}\b/],
  ["a bearer token", /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/i],
  // `(?:\b|_)`: GITHUB_TOKEN=… and OPENAI_API_KEY=… have no word boundary before the keyword (the underscore is a word character).
  ["a credential assignment", /(?:\b|_)(?:api[_-]?key|secret|passw(?:or)?d|token|client[_-]?secret)\s*[:=]\s*["']?[^\s"']{8,}/i],
  ["a URL with a password in it (scheme://user:password@host)", /:\/\/[^/\s:@]+:[^/\s@]+@/],
  // Approval, OAuth and share links carry authority in the URL itself.
  ["a URL carrying a code or token", /[?&#](?:code|token|access_token|id_token|refresh_token|client_secret|api_key|apikey|key|password|user_code|sig|signature|x-amz-signature)=/i],
  ["a Share link (its fragment is the read authority)", /#(?:tc1=|v=\d+&p=)/],
  ["an OpenKey device approval link", /\bopenkey\.so\/device\b/i],
  ["an OAuth/approval URL", /\bhttps?:\/\/[^\s]*\/(?:oauth2?|authorize|login\/device|device\/approve|consent)\b/i],
];

/** Every string in the record that looks like a secret or an approval link, by field path. */
export function findSecrets(value: unknown, path = ""): SecretFinding[] {
  if (typeof value === "string") {
    for (const [reason, pattern] of PATTERNS) {
      if (pattern.test(value)) return [{ path: path || "(value)", reason }];
    }
    if (consentUrlIn(value)) return [{ path: path || "(value)", reason: "an approval or consent link" }];
    return [];
  }
  if (Array.isArray(value)) return value.flatMap((item, index) => findSecrets(item, path ? `${path}.${index}` : String(index)));
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([key, item]) => findSecrets(item, path ? `${path}.${key}` : key));
  }
  return [];
}

const URL_IN_TEXT = /https?:\/\/[^\s<>"'`]+/gi;

/**
 * Whether `text` names an OpenKey or Secret Manager consent page, with or without a query or fragment
 * added. approvalUrlKind alone is not enough for text: it ignores the query on these pages, and the
 * approval exemption is for exact URLs only, so the base (query and fragment cleared) is checked too.
 */
export function consentUrlIn(text: string): boolean {
  for (const match of text.matchAll(URL_IN_TEXT)) {
    const token = match[0].replace(/[.,;:!?)\]}]+$/, "");
    if (approvalUrlKind(token) !== null) return true;
    let url: URL;
    try {
      url = new URL(token);
    } catch {
      continue;
    }
    url.search = "";
    url.hash = "";
    if (approvalUrlKind(url.href) !== null) return true;
  }
  return false;
}

const OPENKEY_CONSENT_PATHS: Record<string, true> = { "/delegate": true, "/device": true, "/oauth/consent": true };

// The manual-redirect authorize URL that `claude setup-token` prints (Claude Code 2.1.299:
// startOAuthFlow with loginWithClaudeAi and inferenceOnly). Claude's public OAuth client, scope
// user:inference only, the code shown on platform.claude.com for pasting back, PKCE S256.
const CLAUDE_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const CLAUDE_CODE_REDIRECT = "https://platform.claude.com/oauth/code/callback";

/** Exactly these eight parameters, each once: no login_hint, no orgUUID, nothing extra. */
function isClaudeSignIn(url: URL): boolean {
  if (url.hostname !== "claude.com" || url.pathname !== "/cai/oauth/authorize") return false;
  // A trailing "&" adds no entry to URLSearchParams, so count the raw separators too.
  if (url.search.split("&").length !== 8) return false;
  const keys = [...url.searchParams.keys()];
  if (keys.length !== 8 || new Set(keys).size !== 8) return false;
  const p = url.searchParams;
  return p.get("code") === "true"
    && p.get("client_id") === CLAUDE_CLIENT_ID
    && p.get("response_type") === "code"
    && p.get("redirect_uri") === CLAUDE_CODE_REDIRECT
    && p.get("scope") === "user:inference"
    && p.get("code_challenge_method") === "S256"
    && /^[A-Za-z0-9_-]{43}$/.test(p.get("code_challenge") ?? "")
    && /^[A-Za-z0-9_-]{43}$/.test(p.get("state") ?? "");
}

/**
 * Which allowlisted consent page this is: an OpenKey consent page (openkey.so/delegate, /device,
 * /oauth/consent), the TinyCloud Secret Manager request page (secrets.tinycloud.xyz/request), or the
 * claude.com sign-in page that `claude setup-token` prints. Exact https origin and path; no
 * credentials, port or fragment. Anything else is null.
 */
export function approvalUrlKind(raw: string): "openkey" | "secrets" | "claude" | null {
  if (/\s/.test(raw)) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash) return null;
  if (url.hostname === "openkey.so" && OPENKEY_CONSENT_PATHS[url.pathname]) return "openkey";
  if (url.hostname === "secrets.tinycloud.xyz" && url.pathname === "/request") return "secrets";
  if (isClaudeSignIn(url) && url.href === raw) return "claude";
  return null;
}

/** findSecrets for a record (or patch) of `kind`: an approval's own `url` may be an allowlisted consent page. */
export function findRecordSecrets(kind: string, value: Record<string, unknown>): SecretFinding[] {
  if (kind === "approval" && typeof value.url === "string") {
    const consent = approvalUrlKind(value.url);
    if (consent) {
      const { url: _consentPage, ...rest } = value;
      return [...findSecrets(rest), ...(consent === "claude" ? claudeParamSecrets(value.url) : [])];
    }
  }
  return findSecrets(value);
}

/**
 * The claude URL is exempt as a whole (its ?code=true and OAuth path would trip the URL patterns), so its
 * parameters are scanned one by one instead. redirect_uri is pinned by isClaudeSignIn and skipped for that reason.
 */
function claudeParamSecrets(raw: string): SecretFinding[] {
  const { redirect_uri: _pinned, ...params } = Object.fromEntries(new URL(raw).searchParams);
  return findSecrets(params);
}

export const LINEAR_ISSUE_BASE = "https://linear.app/tinycloud-labs/issue/";
/** Linear teams whose issue ids (TC-950, OPS-10) become links. Any other KEY-123 stays plain text. */
export const LINEAR_TEAM_KEYS = ["TC", "OPS"] as const;
export const isLinearTeamKey = (key: string): boolean => (LINEAR_TEAM_KEYS as readonly string[]).includes(key);
const ISSUE_RE = /\b([A-Z][A-Z0-9]*)-(\d{1,6})\b/g;

export const linearUrl = (issue: string): string => `${LINEAR_ISSUE_BASE}${issue.toUpperCase()}`;

/** Distinct Linear references (TC-123, OPS-10) in order of first appearance, for the given team keys. */
export function issueRefs(text: string, teamKeys: readonly string[] = LINEAR_TEAM_KEYS): string[] {
  const seen = new Set<string>();
  for (const match of text.matchAll(ISSUE_RE)) if (teamKeys.includes(match[1]!)) seen.add(`${match[1]}-${match[2]}`);
  return [...seen];
}

/** Adds a Linear link for each TC-123 / OPS-10 in the given texts that has no link to that issue yet. */
export function withIssueLinks<L extends { label: string; url: string }>(links: readonly L[], texts: readonly string[]): Array<L | { label: string; url: string }> {
  const out: Array<L | { label: string; url: string }> = [...links];
  for (const ref of issueRefs(texts.join("\n"))) {
    const covered = new RegExp(`/issue/${ref}(?:[/?#]|$)`, "i");
    if (!out.some((link) => covered.test(link.url))) out.push({ label: ref, url: linearUrl(ref) });
  }
  return out;
}
