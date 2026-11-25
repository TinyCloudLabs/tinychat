import { describe, expect, test } from "bun:test";
import type { UserConfig } from "vite";

// The desktop app's "Record this call" tile page (frontend/call-prompt.html) is a build input only for a desktop
// build, where the Tauri CLI sets TAURI_ENV_PLATFORM. The web build deploys its whole dist, so a web dist with the
// page would serve the tile at /call-prompt.html.
async function buildInputs(platform: string | undefined): Promise<string[]> {
  const factory = (await import("../../vite.config")).default as unknown as (env: { command: "build"; mode: string }) => UserConfig;
  const saved = process.env.TAURI_ENV_PLATFORM;
  if (platform === undefined) delete process.env.TAURI_ENV_PLATFORM;
  else process.env.TAURI_ENV_PLATFORM = platform;
  try {
    const input = factory({ command: "build", mode: "production" }).build?.rollupOptions?.input;
    return Object.keys(input as Record<string, string>);
  } finally {
    if (saved === undefined) delete process.env.TAURI_ENV_PLATFORM;
    else process.env.TAURI_ENV_PLATFORM = saved;
  }
}

describe("the tile page as a build input", () => {
  test("a web or phone build has only the app's page", async () => {
    expect(await buildInputs(undefined)).toEqual(["index"]);
  });

  test("a desktop build adds the tile page", async () => {
    expect(await buildInputs("darwin")).toEqual(["index", "call-prompt"]);
  });
});
