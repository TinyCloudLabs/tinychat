import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const INDEX = readFileSync(resolve(import.meta.dir, "../index.ts"), "utf8");

describe("backend index middleware wiring", () => {
  test("trusts exactly one ingress proxy before rate limiters are applied", () => {
    const trustIndex = INDEX.indexOf('app.set("trust proxy", 1)');
    const limiterIndex = INDEX.indexOf("applyRateLimiters(app)");

    expect(trustIndex).toBeGreaterThan(-1);
    expect(limiterIndex).toBeGreaterThan(-1);
    expect(trustIndex).toBeLessThan(limiterIndex);
  });

  test("large NRAS JSON parsing happens after auth on the route mount", () => {
    expect(INDEX).not.toContain('app.use("/api/nras-proxy", express.json({ limit: "4mb" }))');
    expect(INDEX).toContain(
      'app.use("/api/nras-proxy", authMiddleware, express.json({ limit: "4mb" }), createNrasProxyRouter())',
    );
  });
});
