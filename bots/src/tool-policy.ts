// The tools the gateway serves to Main, per MCP server, and the never-list: what Main never reaches, as backend
// route prefixes and tool name patterns. tools/list keeps only allowed tools and tools/call refuses any other name
// before dispatch, so a tool exists for the bot only once it is named here. Tests here and in the backend
// (bots-service-routes.ts) check that no allowed tool or bots service route matches the never-list.
// Details: TC-3795

export type McpServer = "web" | "app";

/** Every tool name the gateway may serve, per MCP server. A new tool is added here, and only if it is on no never-list. */
export const ALLOWED_TOOLS: Readonly<Record<McpServer, readonly string[]>> = {
  web: ["search", "fetch"],
  app: [
    "ask_owner", "request_secret", "list_secrets", "call_with_secret",
    // TrustBot's meeting reads (meeting-reads.ts): read-only, through the owner's grant to TrustBot. TC-3792
    "tinycloud_find_meetings", "tinycloud_read_meeting", "tinycloud_search_transcripts", "tinycloud_list_meeting_actions",
  ],
};

export function toolAllowed(server: McpServer, name: unknown): name is string {
  return typeof name === "string" && ALLOWED_TOOLS[server].includes(name);
}

/** The tools a server offers: those of `tools` on its allow-list, in their order. */
export function servedTools<T extends { name: string }>(server: McpServer, tools: readonly T[]): T[] {
  return tools.filter(tool => toolAllowed(server, tool.name));
}

/** A backend route prefix: the path and everything under it, for one method or (without `method`) any. */
export interface NeverRoute {
  method?: string;
  prefix: string;
}

export interface NeverCategory {
  category: string;
  routes: readonly NeverRoute[];
  /** Matched against a tool name in lower case. */
  tools: RegExp;
}

export const NEVER: readonly NeverCategory[] = [
  {
    category: "billing checkout and portal",
    routes: [{ method: "POST", prefix: "/api/billing/checkout" }, { method: "POST", prefix: "/api/billing/portal" }],
    tools: /checkout|portal|payment|(^|_)pay(_|$)|purchase|subscribe|invoice|refund/,
  },
  {
    category: "delegations and agent access",
    routes: [{ prefix: "/api/delegations" }, { prefix: "/api/exo/v1/grant" }],
    tools: /delegat|grant|agent_?access|(^|_)exo(_|$)/,
  },
  {
    category: "connector sign-in and credentials",
    routes: [
      { method: "POST", prefix: "/api/connectors/credentials" },
      { method: "DELETE", prefix: "/api/connectors/credentials" },
      { prefix: "/api/connectors/google/oauth" },
      { method: "POST", prefix: "/api/connectors/google/autojoin/begin" },
      { method: "POST", prefix: "/api/connectors/google/autojoin/exchange" },
      { method: "POST", prefix: "/api/connectors/google/autojoin/disconnect" },
    ],
    tools: /(^|_)(dis)?connect(_|$)|credential|oauth|log_?in|sign_?in|passkey|password/,
  },
  {
    category: "account deletion",
    routes: [{ method: "DELETE", prefix: "/api/transcriber/meetings" }],
    tools: /(delete|remove|close)_?account|account_?(delet|remov|clos)/,
  },
  {
    // App lock lives in the app alone: there is no backend route to name.
    category: "app lock",
    routes: [],
    tools: /app_?lock|(^|_)(un)?lock(_|$)|passcode/,
  },
  {
    category: "the bot's Web access setting",
    routes: [{ prefix: "/api/bots/main/web" }],
    tools: /web_?(access|policy|setting|mode)|set_web/,
  },
  {
    // Sign-in hands out session tokens.
    category: "secret values",
    routes: [{ prefix: "/api/auth" }],
    tools: /(get|read|reveal|show|export|dump|print|copy|fetch)_?secret|secret_?value|api_?key|token/,
  },
];

/** The never-list category a tool name falls in, if any. */
export function neverTool(name: string): string | undefined {
  const lower = name.toLowerCase();
  return NEVER.find(entry => entry.tools.test(lower))?.category;
}

/** The never-list category a backend route falls in, if any. Paths compare in lower case, as Express routes them. */
export function neverRoute(method: string, path: string): string | undefined {
  const lowerPath = path.toLowerCase().split("?")[0]!;
  const upperMethod = method.toUpperCase();
  return NEVER.find(entry => entry.routes.some(route =>
    (route.method === undefined || route.method === upperMethod)
    && (lowerPath === route.prefix || lowerPath.startsWith(`${route.prefix}/`))))?.category;
}
