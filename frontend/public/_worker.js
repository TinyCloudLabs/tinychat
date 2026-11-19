const OAUTH_DISCOVERY = "https://api.openkey.so/.well-known/oauth-authorization-server/api/auth";
const A2A_AGENT_CARD = "https://tinycloud.xyz/.well-known/agent-card.json";
const HOME_LINK = [
  '</llms.txt>; rel="llms-txt"; type="text/plain"',
  '</.well-known/agent-skills/index.json>; rel="describedby"; type="application/json"',
  '</.well-known/api-catalog>; rel="api-catalog"; type="application/linkset+json"; profile="https://www.rfc-editor.org/info/rfc9727"',
  '</mcp/server-card>; rel="service-desc"; type="application/mcp-server-card+json"',
  '</sitemap.xml>; rel="sitemap"; type="application/xml"',
].join(", ");

const CONTENT_TYPES = new Map([
  ["/robots.txt", "text/plain; charset=utf-8"],
  ["/sitemap.xml", "application/xml; charset=utf-8"],
  ["/llms.txt", "text/plain; charset=utf-8"],
  ["/llms-full.txt", "text/plain; charset=utf-8"],
  ["/auth.md", "text/markdown; charset=utf-8"],
  ["/mcp/server-card", "application/mcp-server-card+json; charset=utf-8"],
  ["/.well-known/api-catalog", 'application/linkset+json; profile="https://www.rfc-editor.org/info/rfc9727"'],
  ["/.well-known/mcp.json", "application/mcp-server-card+json; charset=utf-8"],
  ["/.well-known/mcp/server-card.json", "application/mcp-server-card+json; charset=utf-8"],
]);

function acceptsMarkdown(request) {
  return (request.headers.get("Accept") ?? "")
    .split(",")
    .some((value) => value.trim().split(";", 1)[0].toLowerCase() === "text/markdown");
}

function responseWithHeaders(response, values) {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(values)) headers.set(name, value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function notFound() {
  return new Response("Not found\n", {
    status: 404,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/.well-known/agent-card.json") {
      return new Response(null, {
        status: 302,
        headers: {
          Location: A2A_AGENT_CARD,
          "Cache-Control": "public, max-age=300",
        },
      });
    }

    if (url.pathname === "/.well-known/oauth-authorization-server") {
      return Response.redirect(OAUTH_DISCOVERY, 302);
    }

    if (url.pathname === "/" && acceptsMarkdown(request)) {
      const markdownUrl = new URL("/llms.txt", url);
      const response = await env.ASSETS.fetch(new Request(markdownUrl, request));
      if (!response.ok || response.headers.get("Content-Type")?.startsWith("text/html")) return notFound();
      return responseWithHeaders(response, {
        "Content-Type": "text/markdown; charset=utf-8",
        "Cache-Control": "no-cache",
        Vary: "Accept",
      });
    }

    const response = await env.ASSETS.fetch(request);
    if (url.pathname !== "/" && (!response.ok || response.headers.get("Content-Type")?.startsWith("text/html"))) {
      return notFound();
    }

    if (url.pathname === "/") {
      return responseWithHeaders(response, {
        Link: HOME_LINK,
        Agentmap: "https://tinycloud.one/.well-known/ai-catalog.json",
        Vary: "Accept",
      });
    }

    const values = {
      "Content-Type": CONTENT_TYPES.get(url.pathname) ?? "application/json; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    };
    if (url.pathname.startsWith("/.well-known/") || url.pathname === "/mcp/server-card") {
      values["Access-Control-Allow-Origin"] = "*";
    }
    if (["/robots.txt", "/sitemap.xml", "/llms.txt", "/llms-full.txt", "/auth.md"].includes(url.pathname)) {
      values["Cache-Control"] = "no-cache";
    } else {
      values["Cache-Control"] = "public, max-age=300";
    }
    return responseWithHeaders(response, values);
  },
};
