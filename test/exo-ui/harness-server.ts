// The exo-ui harness page, built once and served from memory: shared by the screenshot run
// (exo-ui-screens.e2e.test.ts) and the interaction tests (recorder-final-phone.e2e.test.ts).
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { OFFERED_CHAT_MODELS } from "../../packages/core/src/chatModels";

const frontend = new URL("../../frontend/", import.meta.url).pathname;

// The backend as a signed-in account with nothing set up sees it. Every other
// /api/ path is a 404.
const API_FIXTURES: Record<string, { status?: number; body: unknown }> = {
  // No agent delegation yet: "Disconnected", with Connect agent.
  "GET /api/agent/session": { body: { status: "none", revision: "harness" } },
  "GET /api/connectors/google/autojoin/status": {
    body: {
      state: "off",
      enabled: false,
      lastScanAt: null,
      errorCode: null,
      outcomes: [],
    },
  },
  "GET /api/transcriber/meetings": { body: { meetings: [] } },
  // The chat's automatic model choice (the shell screens run the real chat).
  "GET /api/chat/model-selection": {
    body: { model: OFFERED_CHAT_MODELS[0].id, reason: "healthy" },
  },
};

// The build line's injected values (TC-840): the same `__EXO_BUILD_INFO__`
// vite.config.ts defines, so captures show the real version, not "unknown".
// package.json is a known file: the cast names its one field, nothing else.
const frontendPkg: { version?: string } = JSON.parse(
  readFileSync(`${frontend}package.json`, "utf8"),
);
let harnessCommit: string | undefined;
try {
  harnessCommit = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
    cwd: frontend,
  })
    .toString()
    .trim();
} catch {
  harnessCommit = undefined;
}
const exoBuildInfo = {
  version: frontendPkg.version,
  commit: harnessCommit,
  channel: "dev",
};

export interface HarnessAssets {
  bundle: string;
  css: string;
  html: string;
}

export async function buildHarness(): Promise<HarnessAssets> {
  const built = await Bun.build({
    entrypoints: [`${frontend}src/harness/exoUiHarness.tsx`],
    root: frontend,
    target: "browser",
    minify: false,
    define: {
      "import.meta.env": "{}",
      __EXO_BUILD_INFO__: JSON.stringify(exoBuildInfo),
    },
    // index.css's @font-face URLs point into frontend/public (served below).
    external: ["/fonts/*"],
  });
  if (!built.success) throw new Error(built.logs.join("\n"));
  const bundle = await built.outputs
    .find((output) => output.kind === "entry-point")!
    .text();
  // Stylesheets that components import themselves (the Soft skin) come out of the build beside the script.
  const componentCss = await Promise.all(
    built.outputs
      .filter((output) => output.path.endsWith(".css"))
      .map((output) => output.text()),
  );

  // The app's own stylesheet, compiled with its Tailwind config.
  const requireFromFrontend = createRequire(`${frontend}package.json`);
  const postcss = requireFromFrontend("postcss");
  const tailwindcss = requireFromFrontend("tailwindcss");
  const source = await Bun.file(`${frontend}src/index.css`).text();
  // The config's content globs are relative; anchor them at frontend/.
  const config = (await import(`${frontend}tailwind.config.js`)).default;
  config.content = [
    `${frontend}index.html`,
    `${frontend}src/**/*.{js,ts,jsx,tsx}`,
  ];
  const css =
    (
      await postcss([tailwindcss(config)]).process(source, {
        from: `${frontend}src/index.css`,
      })
    ).css + componentCss.join("\n");

  // The app's own index.html (metas, font preload, the pre-paint script), with the harness bundle.
  const index = await Bun.file(`${frontend}index.html`).text();
  const appScript = '<script type="module" src="/src/main.tsx"></script>';
  if (!index.includes(appScript) || !index.includes("</head>"))
    throw new Error("index.html changed: update the exo-ui harness page");
  const html = index
    .replace(appScript, '<script type="module" src="/bundle.js"></script>')
    .replace("</head>", '<link rel="stylesheet" href="/app.css" />\n  </head>');
  return { bundle, css, html };
}

export function serveHarness({ bundle, css, html }: HarnessAssets) {
  return Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/bundle.js")
        return new Response(bundle, {
          headers: { "content-type": "text/javascript" },
        });
      if (url.pathname === "/app.css")
        return new Response(css, { headers: { "content-type": "text/css" } });
      if (url.pathname.startsWith("/fonts/")) {
        const file = Bun.file(`${frontend}public${url.pathname}`);
        return (await file.exists())
          ? new Response(file)
          : new Response("not found", { status: 404 });
      }
      if (url.pathname.startsWith("/api/")) {
        const fixture = API_FIXTURES[`${request.method} ${url.pathname}`];
        return fixture === undefined
          ? new Response("not found", { status: 404 })
          : Response.json(fixture.body, { status: fixture.status ?? 200 });
      }
      return new Response(html, { headers: { "content-type": "text/html" } });
    },
  });
}
