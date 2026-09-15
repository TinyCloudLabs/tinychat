import { expect, test } from "bun:test";
import { parseSseJson } from "../routes/agent-chat.js";
async function collect(bytes: Uint8Array, limit = 2097152) {
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      for (let i = 0; i < bytes.length; i += 7)
        c.enqueue(bytes.slice(i, i + 7));
      c.close();
    },
  });
  const values = [];
  for await (const value of parseSseJson(stream, undefined, {
    maxBytes: limit,
    strictUtf8: true,
  }))
    values.push(value);
  return values;
}
test("complete CRLF and fragmented multibyte provider frames are decoded once", async () => {
  expect(
    await collect(
      new TextEncoder().encode(
        'data: {"text":"文🙂"}\r\n\r\ndata: [DONE]\r\n\r\n',
      ),
    ),
  ).toEqual([{ text: "文🙂" }]);
});
test("malformed UTF8 never becomes replacement-character evidence", async () => {
  await expect(
    collect(
      new Uint8Array([
        ...new TextEncoder().encode('data: {"text":"'),
        255,
        ...new TextEncoder().encode('"}\n\ndata: [DONE]\n\n'),
      ]),
    ),
  ).rejects.toBeDefined();
});
test("complete provider framing counts toward a hard byte envelope", async () => {
  const bytes = new TextEncoder().encode(
    'data: {"x":"' + "x".repeat(500) + '"}\n\ndata: [DONE]\n\n',
  );
  await expect(collect(bytes, 512)).rejects.toMatchObject({
    code: "result_size_limit",
  });
});
test("missing DONE never yields a successful complete provider response", async () => {
  await expect(
    collect(new TextEncoder().encode('data: {"x":1}\n\n')),
  ).rejects.toMatchObject({ code: "upstream_incomplete" });
});

// Exercise the actual buffered HTTP adapter, not the controller's model-call fake.
async function buffered(
  usage: unknown,
  phase: "model" | "synthesis" | "repair" = "synthesis",
  expected = 100,
  finalUsage = true,
) {
  const { bufferedMeetingModelCall } = await import("../routes/agent-chat.js");
  let calls = 0;
  const content = {
    id: "synthetic-usage",
    choices: [{ delta: { content: '{"answers":[]}' }, finish_reason: "stop" }],
  };
  const data = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
  const usageFrame = usage === undefined ? "" : data({ choices: [], usage });
  const response = finalUsage
    ? data(content) + usageFrame
    : usageFrame + data(content);
  const promise = bufferedMeetingModelCall(
    {
      model: "z-ai/glm-5.3",
      entityId: "synthetic",
      messages: [],
      write: () => {},
      config: {
        agentId: "synthetic",
        redpillApiKey: "synthetic",
        redpillBaseUrl: "https://synthetic.invalid",
        meetingProvider: {
          model: "z-ai/glm-5.3",
          admitted: true,
          contextTokens: 1048576,
          countInputTokens: () => expected,
        },
        fetchImpl: (async () => {
          calls++;
          return new Response(response + "data: [DONE]\n\n", {
            headers: { "x-request-id": "synthetic-request" },
          });
        }) as typeof fetch,
      },
    } as never,
    {
      phase,
      maxOutputTokens: phase === "model" ? 1024 : 4096,
      messages: [
        { role: "system", content: "Synthetic." },
        { role: "user", content: "{}" },
      ],
    },
  );
  return { promise, calls: () => calls };
}

test("private synthesis and repair require final safe usage matching exact input accounting", async () => {
  for (const phase of ["synthesis", "repair"] as const) {
    const valid = await buffered(
      { prompt_tokens: 100, completion_tokens: 0 },
      phase,
    );
    expect(await valid.promise).toMatchObject({
      promptTokens: 100,
      completionTokens: 0,
      complete: true,
    });
    for (const usage of [
      undefined,
      {},
      { prompt_tokens: -1, completion_tokens: 5 },
      { prompt_tokens: 100, completion_tokens: 1.5 },
      { prompt_tokens: 100, completion_tokens: Number.MAX_SAFE_INTEGER + 1 },
      { prompt_tokens: 100 },
      { prompt_tokens: 99, completion_tokens: 5 },
    ]) {
      const attempt = await buffered(usage, phase);
      await expect(attempt.promise).rejects.toMatchObject({ transient: false });
      expect(attempt.calls()).toBe(1);
    }
  }
});

test("accounting failure retains only validated known usage for terminal billing", async () => {
  const drift = await buffered({ prompt_tokens: 99, completion_tokens: 5 });
  await expect(drift.promise).rejects.toMatchObject({
    message: "provider_token_accounting_mismatch",
    promptTokens: 99,
    completionTokens: 5,
    requestId: "synthetic-request",
    transient: false,
  });
  const invalid = await buffered({ prompt_tokens: -1, completion_tokens: 5 });
  await expect(invalid.promise).rejects.toMatchObject({
    message: "provider_usage_invalid",
    promptTokens: undefined,
    completionTokens: 5,
  });
  const early = await buffered(
    { prompt_tokens: 100, completion_tokens: 5 },
    "synthesis",
    100,
    false,
  );
  await expect(early.promise).rejects.toMatchObject({
    message: "provider_usage_invalid",
    promptTokens: 100,
    completionTokens: 5,
  });
});

test("interpretation and ordinary compaction preserve other models usage compatibility", async () => {
  const attempt = await buffered(undefined, "model");
  expect(await attempt.promise).toMatchObject({
    complete: true,
    promptTokens: 0,
    completionTokens: 0,
  });
});
