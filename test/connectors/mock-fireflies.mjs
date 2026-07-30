// Mock Fireflies GraphQL upstream. See docs/connectors-spec.md §10.
//
// Bun.serve HTTP endpoint at /graphql implementing the three ops the
// FirefliesClient calls: GetUser, ListTranscripts(limit, skip) newest-first
// over a seeded ~30-transcript set, and GetTranscript(id).
//
// Modes (env MOCK_FIREFLIES_MODE, or per-request header x-mock-mode so
// drivers can mix modes across a single upstream instance):
//   happy                  — always ok
//   invalid-key            — always 401 with an unauthenticated GraphQL error
//   rate-limit-429         — first request emits HTTP 429 with retry-after: 0
//                            then the RL is "used up" and everything succeeds
//   rate-limit-graphql     — first request emits GraphQL too_many_requests
//                            then the RL is "used up" and everything succeeds
//   persistent-rate-limit  — EVERY request emits HTTP 429 with retry-after: 1
//                            (never used up). Exercises the client's retry
//                            exhaustion path. Retry-after is tiny so tests
//                            stay fast; drivers pass delayMs:0 anyway.
//
// The one-shot rate-limit modes fire exactly once per handle lifetime;
// drivers can call resetCounters() to re-arm between test cases.
//
// Seed data invariants (asserted by e2e drivers):
//   - one transcript whose raw `duration` (minutes) mismatches its sentence
//     end_time (exercises the connectorStore duration cross-check)
//   - one transcript with a null summary (exercises nullable summary path)

const DEFAULT_MODE = process.env.MOCK_FIREFLIES_MODE || "happy";

const MODES = new Set([
  "happy",
  "invalid-key",
  "rate-limit-429",
  "rate-limit-graphql",
  "persistent-rate-limit",
]);

export const SEED_COUNT = 30;

/** Index of the transcript with the deliberate duration mismatch. */
export const DURATION_MISMATCH_INDEX = 1;
/** Index of the transcript with a null summary. */
export const NULL_SUMMARY_INDEX = 2;

/**
 * Build the seeded transcript set (newest-first — element 0 is newest).
 * Deterministic and pure; drivers can rebuild without spinning the server.
 */
export function buildSeed(count = SEED_COUNT) {
  const baseEpoch = Date.parse("2026-07-01T10:00:00.000Z");
  const transcripts = [];
  for (let i = 0; i < count; i++) {
    // date descends by 1h per index so newest-first ordering is stable.
    const date = baseEpoch - i * 3600_000;

    let duration = 30; // minutes, per Fireflies' undocumented unit
    let sentences = [
      { index: 0, speaker_name: "Ada", text: `talk-${i}-0`, start_time: 0, end_time: 900 },
      { index: 1, speaker_name: "Grace", text: `talk-${i}-1`, start_time: 900, end_time: 1750 },
    ];
    let summary = {
      keywords: ["kickoff", "roadmap"],
      action_items: `Do the thing ${i}`,
      overview: `Overview ${i}`,
      meeting_type: "internal-sync",
    };

    if (i === DURATION_MISMATCH_INDEX) {
      // 5 min raw → 300s computed vs last end 1800s → cross-check must prefer 1800.
      duration = 5;
      sentences = [
        { index: 0, speaker_name: "Ada", text: "long meeting", start_time: 0, end_time: 900 },
        { index: 1, speaker_name: "Grace", text: "still going", start_time: 900, end_time: 1800 },
      ];
    }
    if (i === NULL_SUMMARY_INDEX) {
      summary = null;
    }

    // ids are zero-padded so newest-first ordering stays lexicographic-stable
    // for anyone who wants to sort them — the count-i encoding makes id 030
    // the newest transcript.
    transcripts.push({
      id: `mock-tx-${String(count - i).padStart(3, "0")}`,
      title: `Mock meeting ${i}`,
      date,
      duration,
      organizer_email: `org-${i}@example.com`,
      speakers: [
        { id: 1, name: "Ada" },
        { id: 2, name: "Grace" },
      ],
      meeting_attendees: [
        { displayName: "Ada", email: "ada@example.com" },
        { displayName: "Bob", email: "bob@example.com" },
      ],
      sentences,
      summary,
    });
  }
  return transcripts;
}

const USER = { name: "Mock User", email: "mock@example.com" };

function jsonResponse(payload, init = {}) {
  return new Response(JSON.stringify(payload), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

/**
 * CORS for the browser-e2e lane (test/connectors/browser-lane.ts): the page is
 * served from the vite dev origin and the FirefliesClient posts JSON with an
 * Authorization header, which makes every call a preflighted cross-origin
 * request. Test-only server — the origin is reflected rather than allowlisted.
 */
function corsHeaders(req) {
  return {
    "access-control-allow-origin": req.headers.get("origin") || "*",
    "access-control-allow-headers": "authorization, content-type, x-mock-mode",
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-max-age": "600",
    vary: "origin",
  };
}

/** Classify a GraphQL query string into one of our three ops. */
function classifyOp(query) {
  if (/\bquery\s+GetUser\b/.test(query)) return "user";
  if (/\bquery\s+ListTranscripts\b/.test(query)) return "transcripts";
  if (/\bquery\s+GetTranscript\b/.test(query)) return "transcript";
  return null;
}

/**
 * @typedef {"happy"|"invalid-key"|"rate-limit-429"|"rate-limit-graphql"|"persistent-rate-limit"} MockMode
 * @typedef {object} StartOpts
 * @property {MockMode} [mode]
 * @property {number} [port]
 * @property {object[]} [seed]
 * @typedef {object} MockHandle
 * @property {string} url             POST endpoint the FirefliesClient hits
 * @property {number} port            bound port (ephemeral when opts.port omitted)
 * @property {object[]} seed          the seed array in use
 * @property {Record<string,number>} counts  requests seen per op (all responses, incl RL)
 * @property {() => void} resetCounters  clear counts + re-arm rate-limit modes
 * @property {() => Promise<void>} stop  shut the server down
 */

/**
 * Start the mock upstream on an ephemeral (or specified) port.
 * @param {StartOpts} [opts]
 * @returns {Promise<MockHandle>}
 */
export async function startMockFireflies(opts = {}) {
  const seed = opts.seed ?? buildSeed();
  const defaultMode = opts.mode ?? DEFAULT_MODE;
  if (!MODES.has(defaultMode)) {
    throw new Error(`mock-fireflies: unknown mode "${defaultMode}"`);
  }

  const state = {
    // Rate-limit modes: one limiting response per handle lifetime, then succeed.
    // Tracked as boolean flags per mode so a driver hitting rate-limit-429 and
    // then rate-limit-graphql sees each mode fire once.
    rlUsed: { "rate-limit-429": false, "rate-limit-graphql": false },
    counts: { user: 0, transcripts: 0, transcript: 0 },
  };

  const resetCounters = () => {
    state.rlUsed["rate-limit-429"] = false;
    state.rlUsed["rate-limit-graphql"] = false;
    state.counts.user = 0;
    state.counts.transcripts = 0;
    state.counts.transcript = 0;
  };

  const server = Bun.serve({
    port: opts.port ?? 0,
    hostname: "127.0.0.1",
    // Thin wrapper over `handle` (below) so CORS lands on every response path,
    // including the 401/404/405/429 ones a browser must still be able to read.
    async fetch(req) {
      const res = await handle(req);
      for (const [k, v] of Object.entries(corsHeaders(req))) res.headers.set(k, v);
      return res;
    },
  });

  async function handle(req) {
    // Preflight: the browser sends OPTIONS before the client's POST.
    if (req.method === "OPTIONS") return new Response(null, { status: 204 });
    if (req.method !== "POST") return new Response(null, { status: 405 });
    const url = new URL(req.url);
    if (!/\/graphql\/?$/.test(url.pathname)) return new Response(null, { status: 404 });

    const headerMode = req.headers.get("x-mock-mode") || undefined;
    const mode =
      headerMode && MODES.has(headerMode) ? /** @type {MockMode} */ (headerMode) : defaultMode;

    // Auth: reject if no bearer at all, and always reject in invalid-key mode.
    const auth = req.headers.get("authorization") || "";
    const bearerOk = /^Bearer\s+.+/i.test(auth);
    if (mode === "invalid-key" || !bearerOk) {
      return jsonResponse(
        {
          errors: [
            { message: "Unauthorized", extensions: { code: "unauthenticated" } },
          ],
        },
        { status: 401 },
      );
    }

    let body;
    try {
      body = await req.json();
    } catch {
      return jsonResponse({ errors: [{ message: "invalid JSON" }] }, { status: 400 });
    }

    const query = typeof body?.query === "string" ? body.query : "";
    const variables = body?.variables ?? {};
    const op = classifyOp(query);
    if (!op) return jsonResponse({ errors: [{ message: "unknown op" }] });

    // Rate-limit modes: consume the one-shot on the FIRST request for this
    // mode. We increment the op counter regardless so drivers can see the
    // retry actually happened.
    state.counts[op] += 1;
    if (mode === "persistent-rate-limit") {
      // Never used up — every request rate-limits. retry-after: "1"
      // parses to 1000ms so exhaustion surfaces retryAfterMs > 0; the
      // client honors delayMs:0 so real waits between retries collapse.
      return jsonResponse(
        { errors: [{ message: "Too many requests" }] },
        { status: 429, headers: { "retry-after": "1" } },
      );
    }
    if (mode === "rate-limit-429" && !state.rlUsed["rate-limit-429"]) {
      state.rlUsed["rate-limit-429"] = true;
      return jsonResponse(
        { errors: [{ message: "Too many requests" }] },
        { status: 429, headers: { "retry-after": "0" } },
      );
    }
    if (mode === "rate-limit-graphql" && !state.rlUsed["rate-limit-graphql"]) {
      state.rlUsed["rate-limit-graphql"] = true;
      return jsonResponse({
        errors: [
          {
            // The client parses `retry after <date>` out of the message; a
            // past ISO date collapses to zero wait so tests don't stall.
            message: "Rate limit hit, retry after 1970-01-01T00:00:00.001Z",
            extensions: { code: "too_many_requests" },
          },
        ],
      });
    }

    if (op === "user") {
      return jsonResponse({ data: { user: USER } });
    }
    if (op === "transcripts") {
      const limit = Number.isFinite(variables.limit) ? Math.max(1, Number(variables.limit)) : 25;
      const skip = Number.isFinite(variables.skip) ? Math.max(0, Number(variables.skip)) : 0;
      // seed is already newest-first (index 0 is newest)
      const page = seed.slice(skip, skip + limit).map((t) => ({
        id: t.id,
        title: t.title,
        date: t.date,
        duration: t.duration,
        organizer_email: t.organizer_email,
      }));
      return jsonResponse({ data: { transcripts: page } });
    }
    if (op === "transcript") {
      const id = String(variables.id ?? "");
      const found = seed.find((t) => t.id === id) ?? null;
      return jsonResponse({ data: { transcript: found } });
    }
    return jsonResponse({ data: null });
  }

  return {
    url: `http://127.0.0.1:${server.port}/graphql`,
    port: server.port,
    seed,
    counts: state.counts,
    resetCounters,
    async stop() {
      server.stop(true);
    },
  };
}

// Standalone invocation (for local exploration only — CI never runs this).
if (import.meta.main) {
  const port = Number(process.env.MOCK_FIREFLIES_PORT || 4801);
  const handle = await startMockFireflies({ port, mode: DEFAULT_MODE });
  console.error(`mock-fireflies listening at ${handle.url} mode=${DEFAULT_MODE}`);
}
