/**
 * Joint backend/Eliza denial proof. Run beside the matching Eliza worktree:
 * bun test backend/src/__tests__/agent-task-denial-boundary.test.ts
 * A standalone TinyChat checkout explicitly skips this joint gate.
 */
import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { createAgentTaskClient } from "../agent-task-client.js";
import { addressToEntityId, TINYCHAT_AGENT_ID } from "../entity-id.js";

const elizaSource = new URL("../../../../tinycloud-agents/packages/eliza-service/src/", import.meta.url);
const model = "phala/gpt-oss-120b";
const app = { appId: "tinychat", agentId: TINYCHAT_AGENT_ID };
const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;

test.skipIf(!existsSync(new URL("server.ts", elizaSource)))("actual TaskHandler access denial remains a valid failed final without adding a browser delegation code (requires sibling Eliza checkout)", async () => {
  const { TaskHandler } = await import(new URL("handlers/tasks.ts", elizaSource).href);
  const { ToolError } = await import(new URL("handlers/tools.ts", elizaSource).href);
  let providers = 0;
  let actions = 0;
  const handler = new TaskHandler({ apiKey: "local-provider-fixture", baseUrl: "https://provider.test/v1", models: { [model]: 20000 }, fetchImpl: async () => {
    providers++;
    return new Response(frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: "read-fixture", function: { name: "tinycloud_read_meeting", arguments: '{"focus":"summary"}' } }] } }] })
      + frame({ choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 17, completion_tokens: 5 } }) + "data: [DONE]\n\n");
  } }, { runtimeFor: async () => ({ actions: [{ name: "TINYCLOUD_READ_MEETING", handler: async () => { actions++; throw new ToolError("fixture denied", 403, "access_denied"); } }] }) as any });
  const codes: string[] = [];
  const client = createAgentTaskClient({ baseUrl: "http://service.test", apiKey: "local-service-fixture", fetch: (async (input, init) => {
    const url = String(input);
    if (url.endsWith("/capabilities")) return Response.json({ chatTasks: handler.capabilities(app) });
    const request = new Request(url, init);
    if (url.endsWith("/cancel")) return handler.cancel(request, app, url.split("/").at(-2)!);
    return handler.post(request, app);
  }) as typeof fetch });
  const result = await client.run({ version: 1, executionId: crypto.randomUUID(), entityId: addressToEntityId("0x1111111111111111111111111111111111111111", TINYCHAT_AGENT_ID), model: { id: model, contextWindowTokens: 20000 }, messages: [{ role: "user", content: "Summarize the selected meeting." }], allowedTools: ["tinycloud_read_meeting"], deadlineAt: Date.now() + 10000 }, { onDelegationError: code => { codes.push(code); } });
  expect(result.usage).toMatchObject({ promptTokens: 17, completionTokens: 5 });
  expect(providers).toBe(1); expect(actions).toBe(1);
  expect(codes).toEqual([]);
  expect(result.final?.outcome).toBe("failed");
  expect(result.final?.code).toBe("access_denied");
  expect(result.errorCode).toBeUndefined();
  expect(result.observationComplete).toBe(true);
});
