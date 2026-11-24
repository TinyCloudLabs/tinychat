import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import type { Plugin, UserConfig } from "vite";

// The desktop app's bridge to its own process (ipc: and http://ipc.localhost) belongs only in a desktop build's
// copy of the page policy (TC-3878): vite.config.ts adds it when the Tauri CLI sets TAURI_ENV_PLATFORM. The web
// header, the web page and the phone builds must never carry it, so no other workflow may set that variable.
const repo = new URL("../../../", import.meta.url);
const read = (relative: string) => readFileSync(new URL(relative, repo), "utf8");
const BRIDGE = /ipc:|ipc\.localhost/;

async function desktopIpcPlugin(): Promise<Plugin> {
  const factory = (await import("../../vite.config")).default as unknown as (env: { command: "build"; mode: string }) => UserConfig;
  const plugin = (factory({ command: "build", mode: "production" }).plugins ?? [])
    .flat()
    .find((entry): entry is Plugin => Boolean(entry) && (entry as Plugin).name === "tinychat-desktop-ipc-csp");
  if (!plugin) throw new Error("vite.config.ts has no tinychat-desktop-ipc-csp plugin");
  return plugin;
}

async function transform(html: string, platform: string | undefined): Promise<string> {
  const plugin = await desktopIpcPlugin();
  const saved = process.env.TAURI_ENV_PLATFORM;
  if (platform === undefined) delete process.env.TAURI_ENV_PLATFORM;
  else process.env.TAURI_ENV_PLATFORM = platform;
  try {
    const hook = plugin.transformIndexHtml as (html: string) => string;
    return hook(html);
  } finally {
    if (saved === undefined) delete process.env.TAURI_ENV_PLATFORM;
    else process.env.TAURI_ENV_PLATFORM = saved;
  }
}

describe("the desktop bridge in the page policy", () => {
  test("the web page and the web header name no bridge", () => {
    expect(read("frontend/index.html")).not.toMatch(BRIDGE);
    expect(read("frontend/public/_headers")).not.toMatch(BRIDGE);
  });

  test("a web build leaves the page policy as written, and a desktop build adds the bridge to connect-src", async () => {
    const html = read("frontend/index.html");
    expect(await transform(html, undefined)).toBe(html);
    const desktop = await transform(html, "darwin");
    expect(desktop).toContain("connect-src 'self' ipc: http://ipc.localhost https://");
    expect(desktop.replace("ipc: http://ipc.localhost ", "")).toBe(html);
  });

  test("only the desktop workflows mention TAURI_ENV_PLATFORM", () => {
    const workflows = readdirSync(new URL(".github/workflows/", repo)).filter((name) => /\.ya?ml$/.test(name));
    expect(workflows.length).toBeGreaterThan(0);
    const setting = workflows.filter((name) => read(`.github/workflows/${name}`).includes("TAURI_ENV_PLATFORM"));
    expect(setting.filter((name) => !name.startsWith("desktop"))).toEqual([]);
  });
});

describe("the call prompt tile's page in a desktop build", () => {
  test("is left as written: it has no meta policy to extend, only the desktop app's own", async () => {
    const plugin = await desktopIpcPlugin();
    const html = read("frontend/call-prompt.html");
    expect(html).not.toContain("Content-Security-Policy");
    const saved = process.env.TAURI_ENV_PLATFORM;
    process.env.TAURI_ENV_PLATFORM = "darwin";
    try {
      const hook = plugin.transformIndexHtml as (html: string, ctx: { filename: string }) => string;
      expect(hook(html, { filename: new URL("frontend/call-prompt.html", repo).pathname })).toBe(html);
      const page = read("frontend/index.html");
      expect(hook(page, { filename: new URL("frontend/index.html", repo).pathname })).toContain("connect-src 'self' ipc: http://ipc.localhost https://");
    } finally {
      if (saved === undefined) delete process.env.TAURI_ENV_PLATFORM;
      else process.env.TAURI_ENV_PLATFORM = saved;
    }
  });
});
