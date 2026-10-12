// Local PTX-compatible upstream for the server-delivery smoke. No credentials or signed
// requests are printed. Admin transitions are explicit: a create never auto-completes.
import { createHash, createHmac, randomUUID } from "node:crypto";

const fixtureSegments = [
  { id: "seg_001", speaker_id: "speaker_0", speaker_name: "Alice", start: 32.967, end: 33.967, text: "QUICK BROWN" },
  { id: "seg_002", speaker_id: "speaker_0", speaker_name: "Alice", start: 48.658, end: 50.39, text: "Hello from Alice." },
];

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

// Match ptx's parsed-create hash (and the backend's computeCreateRequestHash).
function requestHash(body) {
  const parsed = {
    meeting_url: body.meeting_url,
    bot_name: body.bot_name ?? undefined,
    language: body.language ?? undefined,
    webhook_url: body.webhook_url ?? undefined,
    platform: body.platform ?? undefined,
    metadata: body.metadata,
  };
  return createHash("sha256").update(canonical(parsed)).digest("hex");
}

export function startMockPtx({ port = 4555, webhookSecret = process.env.MOCK_PTX_WEBHOOK_SECRET } = {}) {
  const meetings = new Map();
  const keys = new Map();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;
      if (path === "/v1/meetings" && req.method === "POST") {
        let input;
        try { input = await req.json(); } catch { return json({ error: { code: "invalid_request" } }, 400); }
        if (!input || typeof input.meeting_url !== "string" || !input.meeting_url ||
          (input.webhook_url !== undefined && typeof input.webhook_url !== "string")) {
          return json({ error: { code: "invalid_request" } }, 400);
        }
        const key = req.headers.get("idempotency-key");
        if (!key) return json({ error: { code: "missing_idempotency_key" } }, 400);
        const hash = requestHash(input);
        const prior = keys.get(key);
        if (prior) {
          if (prior.hash !== hash) return json({ error: { code: "idempotency_conflict" } }, 409);
          const existing = meetings.get(prior.id);
          return existing ? json(existing.meeting) : json({ error: { code: "meeting_not_found" } }, 404);
        }
        const id = `mtg_${randomUUID().replaceAll("-", "")}`;
        const meeting = {
          id, object: "meeting", status: "queued", platform: "jitsi", meeting_url: input.meeting_url,
          bot: { name: input.bot_name ?? "TinyCloud Private Notetaker", joined_at: null },
          created_at: new Date().toISOString(), metadata: input.metadata ?? {},
        };
        meetings.set(id, { meeting, hash, webhookUrl: input.webhook_url ?? null });
        keys.set(key, { id, hash });
        return json(meeting, 201);
      }
      if (path === "/v1/meetings/by-idempotency-key" && req.method === "GET") {
        const match = keys.get(req.headers.get("idempotency-key"));
        const found = match && meetings.get(match.id);
        return found ? json({ meeting: found.meeting, request_hash: match.hash })
          : json({ error: { code: "meeting_not_found" } }, 404);
      }
      const admin = path.match(/^\/(?:__complete|__fail|__recover)\/(mtg_[A-Za-z0-9_-]+)$/);
      if (admin && req.method === "POST") {
        const found = meetings.get(admin[1]);
        if (!found) return json({ error: { code: "meeting_not_found" } }, 404);
        if (path.startsWith("/__recover/")) {
          found.meeting.status = "processing";
          delete found.meeting.ended_at;
          delete found.meeting.completed_at;
          delete found.meeting.error;
          return json(found.meeting);
        }
        const completed = path.startsWith("/__complete/");
        found.meeting.status = completed ? "completed" : "failed";
        found.meeting.ended_at = new Date().toISOString();
        if (completed) {
          found.meeting.completed_at = found.meeting.ended_at;
          delete found.meeting.error;
        } else {
          found.meeting.error = { type: "upstream", code: "mock_failure", message: "Mock failure" };
        }
        if (!found.webhookUrl) return json({ error: { code: "missing_webhook_url" } }, 409);
        const type = completed ? "meeting.completed" : "meeting.failed";
        const deliveryId = `whd_${randomUUID()}`;
        const event = JSON.stringify({
          id: `evt_${randomUUID()}`, type, created_at: new Date().toISOString(),
          data: { meeting_id: admin[1], status: found.meeting.status, metadata: found.meeting.metadata,
            ...(completed ? { transcript_provider: "vexa" } : { error: found.meeting.error }) },
        });
        let webhook;
        try {
          webhook = await fetch(found.webhookUrl, {
            method: "POST", signal: AbortSignal.timeout(10_000),
            headers: {
              "content-type": "application/json", "x-webhook-event": type, "x-webhook-delivery": deliveryId,
              ...(webhookSecret ? { "x-webhook-signature": `sha256=${createHmac("sha256", webhookSecret).update(event).digest("hex")}` } : {}),
            },
            body: event,
          });
        } catch {
          return json({ error: { code: "webhook_transport_failure" } }, 502);
        }
        return json({ id: admin[1], webhook_status: webhook.status, delivery_id: deliveryId }, webhook.status === 202 ? 200 : 502);
      }
      const match = path.match(/^\/v1\/meetings\/(mtg_[A-Za-z0-9_-]+)(?:\/(stop|transcript))?$/);
      if (!match) return json({ error: { code: "not_found" } }, 404);
      const found = meetings.get(match[1]);
      if (!found) return json({ error: { code: "meeting_not_found" } }, 404);
      if (req.method === "DELETE" && !match[2]) {
        meetings.delete(match[1]);
        return new Response(null, { status: 204 });
      }
      if (req.method === "POST" && match[2] === "stop") {
        if (!["completed", "failed"].includes(found.meeting.status)) found.meeting.status = "cancelled";
        return json({ id: match[1], status: found.meeting.status });
      }
      if (req.method === "GET" && match[2] === "transcript") {
        if (found.meeting.status !== "completed") return json({ meeting_id: match[1], status: found.meeting.status }, 202);
        return json({
          meeting_id: match[1], status: "completed", language: "en", duration_seconds: 102.54,
          speakers: [{ id: "speaker_0", name: "Alice" }, { id: "speaker_1", name: "Alice" }, { id: "speaker_2", name: " " }],
          segments: fixtureSegments, text: "Alice: QUICK BROWN\nAlice: Hello from Alice.",
          created_at: found.meeting.completed_at, provider: "vexa",
        });
      }
      if (req.method === "GET" && !match[2]) return json(found.meeting);
      return json({ error: { code: "not_found" } }, 404);
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

if (import.meta.main) {
  const port = Number(process.env.MOCK_PTX_PORT ?? "4555");
  const mock = startMockPtx({ port });
  console.log(`mock-ptx listening at ${mock.url}`);
}
