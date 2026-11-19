import { expect, test } from "bun:test";
import { registerTinyCloudWebMcp, tinyCloudAppCatalog } from "./webMcp";

test("the WebMCP app catalog uses TinyCloud One's existing app links", async () => {
  expect(tinyCloudAppCatalog()).toEqual([
    {
      identifier: "xyz.tinycloud.sample.healthlog",
      name: "Health Log",
      description: "A small health log: meals with macros, body weight, a today card and a last-7-days chart.",
      url: "https://share.tinycloud.xyz/apps/run#xyz.tinycloud.sample.healthlog",
    },
    {
      identifier: "xyz.tinycloud.sample.recipes",
      name: "Recipes",
      description: "A small recipe book: shelves, recipes, and recipes started from a meal in the Health Log.",
      url: "https://share.tinycloud.xyz/apps/run#xyz.tinycloud.sample.recipes",
    },
  ]);
});

test("registers one read-only app-catalog tool on document.modelContext", async () => {
  const registrations: Array<{ tool: Record<string, unknown>; signal: AbortSignal }> = [];
  const navigatorRegistrations: unknown[] = [];
  const documentContext = {
    registerTool(tool: Record<string, unknown>, options: { signal: AbortSignal }) {
      registrations.push({ tool, signal: options.signal });
    },
  };
  const navigatorContext = {
    registerTool(tool: unknown) {
      navigatorRegistrations.push(tool);
    },
  };

  const controller = registerTinyCloudWebMcp({
    document: { modelContext: documentContext },
    navigator: { modelContext: navigatorContext },
  });

  expect(registrations).toHaveLength(1);
  expect(navigatorRegistrations).toHaveLength(0);
  expect(registrations[0]!.tool).toMatchObject({
    name: "list_tinycloud_apps",
    description: "Lists the apps available from TinyCloud One, with each app's name, description, identifier, and Share URL.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  });
  const result = await (registrations[0]!.tool.execute as () => Promise<unknown>)();
  expect(result).toEqual({
    content: [{ type: "text", text: JSON.stringify({ apps: tinyCloudAppCatalog() }) }],
    structuredContent: { apps: tinyCloudAppCatalog() },
  });
  expect(registrations[0]!.signal.aborted).toBe(false);
  controller?.abort();
  expect(registrations[0]!.signal.aborted).toBe(true);
});

test("falls back to navigator.modelContext and does nothing without WebMCP", async () => {
  const registrations: unknown[] = [];
  const controller = registerTinyCloudWebMcp({
    navigator: { modelContext: { registerTool(tool: unknown) { registrations.push(tool); } } },
  });

  expect(registrations).toHaveLength(1);
  expect(controller).toBeInstanceOf(AbortController);
  expect(registerTinyCloudWebMcp({})).toBeUndefined();
});
