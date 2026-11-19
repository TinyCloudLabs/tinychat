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

export interface WebMcpRoot {
  document?: ModelContextHolder;
  navigator?: ModelContextHolder;
}

export function tinyCloudAppCatalog() {
  return SHARE_APPS.map((app) => ({
    identifier: app.appId,
    name: app.name,
    description: app.description,
    url: shareRunUrl(app.appId),
  }));
}

function browserRoot(): WebMcpRoot {
  return {
    ...(typeof document === "undefined" ? {} : { document: document as unknown as ModelContextHolder }),
    ...(typeof navigator === "undefined" ? {} : { navigator: navigator as unknown as ModelContextHolder }),
  };
}

export function registerTinyCloudWebMcp(root: WebMcpRoot = browserRoot()): AbortController | undefined {
  const modelContext = root.document?.modelContext ?? root.navigator?.modelContext;
  if (!modelContext || typeof modelContext.registerTool !== "function") return undefined;

  const controller = new AbortController();
  const tool: WebMcpTool = {
    name: "list_tinycloud_apps",
    description: "Lists the apps available from TinyCloud One, with each app's name, description, identifier, and Share URL.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
    execute() {
      const apps = tinyCloudAppCatalog();
      const structuredContent = { apps };
      return {
        content: [{ type: "text", text: JSON.stringify(structuredContent) }],
        structuredContent,
      };
    },
  };

  try {
    const registration = modelContext.registerTool(tool, { signal: controller.signal });
    if (registration) void registration.catch(() => {});
  } catch {
    return undefined;
  }
  return controller;
}
