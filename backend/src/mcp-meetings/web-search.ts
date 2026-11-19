/**
 * Public web search through Tavily, ported unchanged in behavior from eliza-service actions/web-search.ts
 * (same endpoint, parameters, result bound and summary), so chat keeps its web search without eliza-service.
 * It touches no user space and needs no delegation.
 */
import { checkContext, MeetingRetrievalError, withinContext } from "./evidence.js";
import type { RetrievalContext } from "./evidence.js";
import { ToolError } from "./tools.js";

const TAVILY_ENDPOINT = "https://api.tavily.com/search";
const MAX_RESULTS = 5;

interface TavilyResult { title?: string; url?: string; content?: string }
interface TavilyResponse { answer?: string; results?: TavilyResult[] }

/** Prefer Tavily's synthesized answer; otherwise summarize the top results. */
function summarize(data: TavilyResponse): string {
  if (data.answer && data.answer.trim()) return data.answer.trim();
  const top = (data.results ?? []).slice(0, 3)
    .map(result => `- ${result.title ?? "(untitled)"}: ${(result.content ?? "").slice(0, 280)}` + (result.url ? ` (${result.url})` : ""))
    .join("\n");
  return top || "No results found.";
}

export async function webSearch(
  args: Record<string, unknown>,
  options: { apiKey: string | undefined; fetchImpl?: typeof fetch; context?: RetrievalContext },
): Promise<{ status: number; body: Record<string, unknown> }> {
  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (!query) return { status: 400, body: { error: "invalid_args" } };
  if (!options.apiKey) return { status: 500, body: { error: "tool_misconfigured" } };
  const context = options.context ?? {};
  const doFetch = options.fetchImpl ?? fetch;
  try {
    const data = await withinContext(async signal => {
      let response: Response;
      try {
        response = await doFetch(TAVILY_ENDPOINT, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ api_key: options.apiKey, query, max_results: MAX_RESULTS, include_answer: true, search_depth: "basic" }),
          signal,
        });
      } catch {
        checkContext({ ...context, signal });
        throw new ToolError("web_search: upstream request failed", 502, "tool_upstream_error");
      }
      checkContext({ ...context, signal });
      if (!response.ok) throw new ToolError("web_search: upstream response failed", 502, "tool_upstream_error");
      return await response.json() as TavilyResponse;
    }, context);
    const text = summarize(data);
    return {
      status: 200,
      body: {
        ok: true,
        tool: "web_search",
        result: {
          text,
          data: {
            query,
            answer: data.answer ?? null,
            results: (data.results ?? []).slice(0, MAX_RESULTS).map(result => ({ title: result.title ?? null, url: result.url ?? null, snippet: result.content ?? null })),
          },
          frames: [{ text }],
        },
      },
    };
  } catch (error) {
    if (error instanceof ToolError) return { status: error.status, body: { error: error.code } };
    if (error instanceof MeetingRetrievalError) return { status: error.status, body: { error: error.code } };
    return { status: 502, body: { error: "tool_failed" } };
  }
}
