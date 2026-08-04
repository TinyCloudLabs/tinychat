import { describe, expect, test } from "bun:test";

import { CONNECTORS } from "./registry";

const SECRET_NAME_RE = /^[A-Z][A-Z0-9_]*$/;

describe("connector registry", () => {
  test("connector ids are unique", () => {
    const ids = CONNECTORS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("fireflies is registered and available", () => {
    const fireflies = CONNECTORS.find((c) => c.id === "fireflies");
    expect(fireflies).toBeDefined();
    expect(fireflies?.status).toBe("available");
  });

  test("granola and google-meet are registered as coming-soon", () => {
    for (const id of ["granola", "google-meet"] as const) {
      const entry = CONNECTORS.find((c) => c.id === id);
      expect(entry).toBeDefined();
      expect(entry?.status).toBe("coming-soon");
    }
  });

  test("every secretName matches /^[A-Z][A-Z0-9_]*$/", () => {
    for (const c of CONNECTORS) {
      expect(c.secretName).toMatch(SECRET_NAME_RE);
    }
  });

  test("secretScope matches the connector id", () => {
    for (const c of CONNECTORS) {
      expect(c.secretScope).toBe(c.id);
    }
  });

  test("source column value is present and matches id for v1 connectors", () => {
    for (const c of CONNECTORS) {
      expect(typeof c.source).toBe("string");
      expect(c.source.length).toBeGreaterThan(0);
      expect(c.source).toBe(c.id);
    }
  });
});
