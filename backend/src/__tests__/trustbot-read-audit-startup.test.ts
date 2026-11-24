import { expect, test } from "bun:test";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { mcpChatFromEnv } from "../mcp-meetings/config.js";
import { transcriptDeliveryConfigFromEnv } from "../services/transcription-api.js";

test("backend boot delegates audit retention without a timer in the startup VM", async () => {
  const index = new URL("../index.ts", import.meta.url);
  const source = (await Bun.file(index).text()).replaceAll("import.meta.url", JSON.stringify(index.href));
  const built = await Bun.build({
    entrypoints: [fileURLToPath(index)], target: "node", format: "cjs", external: ["*"],
    plugins: [{
      name: "audit-startup-entry",
      setup(builder) {
        builder.onLoad({ filter: /\/index\.ts$/ }, () => ({
          contents: source + "\nexport { main as boot };", loader: "ts",
        }));
      },
    }],
  });
  const load = createRequire(index);
  const node = { kv: { list: async () => ({ data: { keys: [] } }) } };
  const events: string[] = [];
  const noop = () => {};
  const middleware = () => noop;
  const stop = new Error("reached plain chat route");
  const app = { set: noop, use: noop, post: noop, get: noop };
  const express = Object.assign(() => app, { raw: middleware, json: middleware });
  const module = { exports: {} as { boot(): Promise<void> } };
  const env = { BACKEND_PRIVATE_KEY: "synthetic-private-key" };
  const auditImports = {
    RetainedReadAudit: class {
      constructor(backend: unknown) {
        expect(backend).toBe(node);
        events.push("audit");
      }
    },
  };
  const modules: Record<string, unknown> = {
    express, cors: middleware,
    fs: { existsSync: () => false }, path: load("node:path"), url: load("node:url"),
    "./startup.js": { createTinychatBackendIdentity: async () => ({ node, did: "synthetic-backend-did" }) },
    "./rate-limits.js": { applyRateLimiters: () => ({ globalRoutes: {}, paidChatLimiter: middleware() }), logGlobalBucketRoutes: noop },
    "./exo/mailbox.js": { exoCapabilitiesEnabled: () => false },
    "./exo/stores.js": { createOwnerGrantOpener: () => async () => null },
    "./exo/grant-holders.js": { GrantHolderIndex: class { async refresh() {} }, createTrackedGrantStore: (store: unknown) => store },
    "./services/transcription-api.js": { transcriptDeliveryConfigFromEnv, transcriptionApiConfigFromEnv: () => undefined },
    "./services/assemblyai-hosted.js": load("./services/assemblyai-hosted.ts"),
    "./services/private-cloud-transcription.js": load("./services/private-cloud-transcription.ts"),
    "./mcp-meetings/config.js": { mcpChatFromEnv },
    "./trustbot-reads/audit.js": auditImports,
    "./routes/chat.js": { defaultModel: "synthetic-model", createChatRouter: () => { events.push("chat"); throw stop; } },
  };
  runInNewContext(await built.outputs[0]!.text(), {
    Error, module, exports: module.exports,
    process: { env, argv: [], cwd: () => "/synthetic-startup", exit: () => { throw new Error("unexpected exit"); } },
    console: { log: noop, warn: noop, error: noop },
    require: (id: string) => modules[id] ?? new Proxy({}, {
      get: (_target, key) => key === "__esModule" ? false : function () {},
    }),
  });
  await expect(module.exports.boot()).rejects.toBe(stop);
  expect(events).toEqual(["audit", "chat"]);
});
