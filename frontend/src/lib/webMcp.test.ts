import { expect, test } from "bun:test";
import {
  registerTinyCloudWebMcp,
  setTinyCloudWebMcpFeedLoader,
  tinyCloudAppCatalog,
} from "./webMcp";

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
    description: "Lists the apps available from TinyCloud One, with each app's name, description, identifier and Share URL.",
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

test("registers the Feed tool only with its default-off local device setting", async () => {
  const registrations: Array<Record<string, unknown>> = [];
  setTinyCloudWebMcpFeedLoader(null);
  const controller = registerTinyCloudWebMcp({
    document: {
      modelContext: {
        registerTool(tool: Record<string, unknown>) {
          registrations.push(tool);
        },
      },
    },
    localStorage: { getItem: () => "enabled" },
  });

  expect(registrations).toHaveLength(2);
  expect(registrations[1]).toMatchObject({
    name: "list_tinycloud_feed_cards",
    description: "Lists the signed-in owner's Feed cards, with each card's source, identifier, type, title, summary, when it was created and whether it needs a response.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  });
  const result = await (registrations[1]!.execute as () => Promise<unknown>)();
  const structuredContent = {
    signInRequired: true,
    message: "Sign in to list the owner's Feed cards.",
  };
  expect(result).toEqual({
    content: [{ type: "text", text: JSON.stringify(structuredContent) }],
    structuredContent,
  });
  controller?.abort();
});

test("the Feed tool returns metadata and existing summaries without card bodies", async () => {
  const registrations: Array<Record<string, unknown>> = [];
  setTinyCloudWebMcpFeedLoader(async () => ({
    entries: [
      {
        source: { sourceId: "source-1", label: "Trips" },
        state: {
          card: {
            cardId: "card-1",
            kind: "question",
            title: "Choose a train",
            body: "Private body that must not leave the Feed.",
            createdAt: "2026-11-19T00:00:00.000Z",
            needsResponse: true,
            payload: { summary: "Two times are available." },
          },
        },
      },
      {
        source: { sourceId: "source-2", label: "Reports" },
        state: {
          card: {
            cardId: "card-2",
            kind: "post",
            title: "Daily report",
            body: "Another private body.",
            createdAt: "2026-11-19T01:00:00.000Z",
            needsResponse: true,
            payload: {},
          },
          response: { responseId: "response-1" },
        },
      },
    ],
  }));
  registerTinyCloudWebMcp({
    document: {
      modelContext: {
        registerTool(tool: Record<string, unknown>) {
          registrations.push(tool);
        },
      },
    },
    localStorage: { getItem: () => "enabled" },
  });

  const result = await (registrations[1]!.execute as () => Promise<{
    content: Array<{ text: string }>;
    structuredContent: unknown;
  }>)();
  const structuredContent = {
    cards: [
      {
        source: { identifier: "source-1", name: "Trips" },
        identifier: "card-1",
        type: "question",
        title: "Choose a train",
        summary: "Two times are available.",
        createdAt: "2026-11-19T00:00:00.000Z",
        needsResponse: true,
      },
      {
        source: { identifier: "source-2", name: "Reports" },
        identifier: "card-2",
        type: "post",
        title: "Daily report",
        createdAt: "2026-11-19T01:00:00.000Z",
        needsResponse: false,
      },
    ],
  };
  expect(result).toEqual({
    content: [{ type: "text", text: JSON.stringify(structuredContent) }],
    structuredContent,
  });
  expect(result.content[0]!.text).not.toContain("Private body");
  setTinyCloudWebMcpFeedLoader(null);
});
