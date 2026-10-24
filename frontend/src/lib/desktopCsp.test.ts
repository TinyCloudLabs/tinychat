import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "bun:test";

// The desktop app's content security policy is a security surface: a widening has to be a visible change here.
const config = JSON.parse(readFileSync(fileURLToPath(new URL("../../../desktop/src-tauri/tauri.conf.json", import.meta.url)), "utf8")) as {
  app: { security: { csp: Record<string, string> } };
  bundle: { macOS: Record<string, unknown> };
};
const csp = config.app.security.csp;

const CONNECT_SRC = [
  "'self'",
  "ipc:",
  "http://ipc.localhost",
  "https://api.tinycloud.chat",
  "https://tee.node.tinycloud.xyz",
  "https://node.tinycloud.xyz",
  "https://registry.tinycloud.xyz",
  "https://openkey.so",
  "https://api.openkey.so",
  "https://api.redpill.ai",
  "https://rpc.ata.network",
  "https://search.sigstore.dev",
  "https://api-github-proxy.tinfoil.sh",
  "https://gh-attestation-proxy.tinfoil.sh",
  "https://api.fireflies.ai",
  "https://www.googleapis.com",
  "https://docs.googleapis.com",
  "https://meet.googleapis.com",
  "https://api.assemblyai.com",
  "https://f6663e38e8fc0a7d706ec2facb861246ae0077d8-8080.dstack-pha-prod5.phala.network",
  "http://127.0.0.1:*",
];

describe("desktop CSP", () => {
  it("connect-src is exactly this list; loopback is the literal IP on any port and nothing else", () => {
    expect(csp["connect-src"]!.split(" ")).toEqual(CONNECT_SRC);
  });

  it("allows no other plain-http or wildcard source, and never 'localhost' or an IPv6 loopback", () => {
    const sources = csp["connect-src"]!.split(" ");
    expect(sources.filter((source) => source.startsWith("http://"))).toEqual(["http://ipc.localhost", "http://127.0.0.1:*"]);
    expect(sources.filter((source) => source.includes("*"))).toEqual(["http://127.0.0.1:*"]);
    expect(sources.some((source) => /localhost:|\[::1\]/.test(source))).toBe(false);
    expect(sources).not.toContain("http:");
    expect(sources).not.toContain("https:");
    expect(sources).not.toContain("ws:");
  });

  it("leaves the other directives as they were: no loopback in frames, images or scripts", () => {
    expect(csp["frame-src"]).toBe("https://openkey.so");
    expect(csp["img-src"]).toBe("'self' data: blob: https:");
    expect(csp["script-src"]).toBe("'self' 'wasm-unsafe-eval'");
    expect(csp["default-src"]).toBe("'self'");
    expect(csp["object-src"]).toBe("'none'");
    expect(Object.keys(csp).sort()).toEqual(["base-uri", "connect-src", "default-src", "font-src", "form-action", "frame-src", "img-src", "object-src", "script-src", "style-src"]);
  });

  it("never turns off macOS app transport security (at most NSAllowsLocalNetworking, if the Mac test needs it)", () => {
    const infoPlist = readFileSync(fileURLToPath(new URL("../../../desktop/src-tauri/Info.plist", import.meta.url)), "utf8");
    for (const text of [JSON.stringify(config.bundle.macOS), infoPlist]) {
      expect(text).not.toContain("NSAllowsArbitraryLoads");
      expect(text).not.toContain("NSAllowsArbitraryLoadsInWebContent");
    }
  });
});
