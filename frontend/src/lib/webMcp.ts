import { SHARE_APPS, shareRunUrl } from "../home/shareApps";

interface WebMcpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: { readOnlyHint: true };
  execute: () => unknown;
}

interface ModelContext {
  registerTool(tool: WebMcpTool, options: { signal: AbortSignal }): void | Promise<void>;
}

interface ModelContextHolder {
  modelContext?: ModelContext;
}

interface WebMcpFeedEntry {
  source: { sourceId: string; label: string };
  state: {
    card: {
      cardId: string;
      kind: string;
      title: string;
      createdAt: string;
      needsResponse: boolean;
      payload?: { summary?: unknown };
    };
    response?: unknown;
  };
}

type WebMcpFeedLoader = () => Promise<{ entries: WebMcpFeedEntry[] }>;

export interface WebMcpRoot {
  document?: ModelContextHolder;
  navigator?: ModelContextHolder;
  location?: { search: string };
}

let feedLoader: WebMcpFeedLoader | null = null;

export function setTinyCloudWebMcpFeedLoader(loader: WebMcpFeedLoader | null): void {
  feedLoader = loader;
}

export function tinyCloudAppCatalog() {
  return SHARE_APPS.map((app) => ({
    identifier: app.appId,
    name: app.name,
    description: app.description,
    url: shareRunUrl(app.appId),
  }));
}

function toolResult(structuredContent: Record<string, unknown>) {
  return {
    content: [{ type: "text", text: JSON.stringify(structuredContent) }],
    structuredContent,
  };
}

function appCatalogTool(): WebMcpTool {
  return {
    name: "list_tinycloud_apps",
    description: "Lists the apps available from TinyCloud One, with each app's name, description, identifier and Share URL.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
    execute() {
      return toolResult({ apps: tinyCloudAppCatalog() });
    },
  };
}

function feedCardsTool(): WebMcpTool {
  return {
    name: "list_tinycloud_feed_cards",
    description: "Lists the signed-in owner's Feed cards, with each card's source, identifier, type, title, summary, when it was created and whether it needs a response.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
    async execute() {
      const load = feedLoader;
      if (!load) {
        return toolResult({
          signInRequired: true,
          message: "Sign in to list the owner's Feed cards.",
        });
      }
      const { entries } = await load();
      const cards = entries.map((entry) => {
        const { card } = entry.state;
        const summary = card.payload?.summary;
        return {
          source: { identifier: entry.source.sourceId, name: entry.source.label },
          identifier: card.cardId,
          type: card.kind,
          title: card.title,
          ...(typeof summary === "string" ? { summary } : {}),
          createdAt: card.createdAt,
          needsResponse: card.needsResponse && !entry.state.response,
        };
      });
      return toolResult({ cards });
    },
  };
}

function browserRoot(): WebMcpRoot {
  return {
    ...(typeof document === "undefined" ? {} : { document: document as unknown as ModelContextHolder }),
    ...(typeof navigator === "undefined" ? {} : { navigator: navigator as unknown as ModelContextHolder }),
    ...(typeof location === "undefined" ? {} : { location }),
  };
}

export function registerTinyCloudWebMcp(root: WebMcpRoot = browserRoot()): AbortController | undefined {
  const modelContext = root.document?.modelContext ?? root.navigator?.modelContext;
  if (!modelContext || typeof modelContext.registerTool !== "function") return undefined;

  const controller = new AbortController();
  const tools = [
    appCatalogTool(),
    ...(new URLSearchParams(root.location?.search ?? "").get("webmcp") === "feed" ? [feedCardsTool()] : []),
  ];
  try {
    for (const tool of tools) {
      const registration = modelContext.registerTool(tool, { signal: controller.signal });
      if (registration) void registration.catch(() => {});
    }
  } catch {
    return undefined;
  }
  return controller;
}
