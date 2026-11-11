// MOCK model for the local smoke only (test/smoke.sh mounts it into the gateway container; the image never ships
// it). An OpenAI-compatible stand-in that answers "pong", streamed in two pieces. It logs the shape of each
// request it receives (field names and the provider block, never message text) so the smoke can show what the
// gateway forwarded.
const MODELS = ["z-ai/glm-5.2", "mock/not-allowed"];

Bun.serve({
  hostname: "127.0.0.1",
  port: Number(process.env.MOCK_PORT ?? 9099),
  async fetch(req) {
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === "/v1/models") {
      return Response.json({ object: "list", data: MODELS.map(id => ({ id, object: "model" })) });
    }
    if (req.method !== "POST" || url.pathname !== "/v1/chat/completions") return new Response("not found", { status: 404 });
    const body = (await req.json()) as Record<string, unknown>;
    console.log(
      JSON.stringify({
        mock: "request",
        authorization: req.headers.get("authorization") === "Bearer mock-model-key" ? "model key" : "other",
        fields: Object.keys(body).sort(),
        provider: body.provider,
        stream_options: body.stream_options,
        max_tokens: body.max_tokens,
      }),
    );
    const base = { id: "mock-1", created: Math.floor(Date.now() / 1000), model: body.model };
    const usage = { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 };
    if (body.stream !== true) {
      return Response.json({
        ...base,
        object: "chat.completion",
        choices: [{ index: 0, message: { role: "assistant", content: "pong" }, finish_reason: "stop" }],
        usage,
      });
    }
    const chunk = (delta: Record<string, unknown>, finish: string | null) => ({
      ...base,
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta, finish_reason: finish }],
    });
    const events = [
      chunk({ role: "assistant", content: "po" }, null),
      chunk({ content: "ng" }, null),
      chunk({}, "stop"),
      { ...base, object: "chat.completion.chunk", choices: [], usage },
    ];
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        for (const event of events) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
          await Bun.sleep(150);
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    return new Response(stream, { headers: { "content-type": "text/event-stream" } });
  },
});
console.log(JSON.stringify({ mock: "listening" }));
