import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// The desktop webview PUTs picked audio to VITE_EXO_PTX_UPLOAD_ORIGIN (putFileToPtx), and its
// Content-Security-Policy refuses any origin connect-src does not list. When the origin moved (TC-3556)
// only .env.production changed, so Upload audio broke on desktop. This ties the two files together.
const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), "utf8");

const productionEnv = Object.fromEntries(
  read("../../.env.production").split("\n").filter((line) => /^[A-Z_]+=/.test(line)).map((line) => {
    const at = line.indexOf("=");
    return [line.slice(0, at), line.slice(at + 1).trim()];
  }),
);
const connectSources = (JSON.parse(read("../../../desktop/src-tauri/tauri.conf.json")) as {
  app: { security: { csp: Record<string, string> } };
}).app.security.csp["connect-src"].split(/\s+/);

describe("desktop Content-Security-Policy and the production PTX upload origin", () => {
  test("connect-src lists VITE_EXO_PTX_UPLOAD_ORIGIN from frontend/.env.production", () => {
    const origin = productionEnv.VITE_EXO_PTX_UPLOAD_ORIGIN;
    expect(origin).toMatch(/^https:\/\/[^/]+$/);
    expect(connectSources).toContain(origin);
  });

  test("connect-src carries no other phala.network host, so a retired upload host cannot linger", () => {
    const phalaHosts = connectSources.filter((source) => /\.phala\.network$/.test(source));
    expect(phalaHosts).toEqual([productionEnv.VITE_EXO_PTX_UPLOAD_ORIGIN]);
  });
});
