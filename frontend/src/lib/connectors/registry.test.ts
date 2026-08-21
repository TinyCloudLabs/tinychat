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

  test("granola is registered as coming-soon", () => {
    const granola = CONNECTORS.find((c) => c.id === "granola");
    expect(granola).toBeDefined();
    expect(granola?.status).toBe("coming-soon");
  });

  test("google-meet is registered and available", () => {
    const gmeet = CONNECTORS.find((c) => c.id === "google-meet");
    expect(gmeet).toBeDefined();
    expect(gmeet?.status).toBe("available");
  });

  test("every secretName matches /^[A-Z][A-Z0-9_]*$/", () => {
    for (const c of CONNECTORS) {
      expect(c.secretName).toMatch(SECRET_NAME_RE);
    }
  });

  test("google-meet stores a refresh token, not an api key", () => {
    const gmeet = CONNECTORS.find((c) => c.id === "google-meet");
    expect(gmeet?.secretName).toBe("REFRESH_TOKEN");
  });

  test("source API keys use the same global names as Listen", () => {
    const fireflies = CONNECTORS.find((c) => c.id === "fireflies");
    const granola = CONNECTORS.find((c) => c.id === "granola");

    expect(fireflies?.secretName).toBe("FIREFLIES_API_KEY");
    expect(fireflies?.secretScope).toBeUndefined();
    expect(granola?.secretName).toBe("GRANOLA_API_KEY");
    expect(granola?.secretScope).toBeUndefined();
  });

  test("OAuth refresh tokens remain connector-scoped", () => {
    const gmeet = CONNECTORS.find((c) => c.id === "google-meet");
    expect(gmeet?.secretScope).toBe("google-meet");
  });

  test("source column value is present and matches id for v1 connectors", () => {
    for (const c of CONNECTORS) {
      expect(typeof c.source).toBe("string");
      expect(c.source.length).toBeGreaterThan(0);
      expect(c.source).toBe(c.id);
    }
  });
});
