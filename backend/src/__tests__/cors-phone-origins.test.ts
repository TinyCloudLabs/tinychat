import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import cors from "cors";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { appCorsOptions, frontendOriginsFromEnv } from "../cors-origins.js";

const PHONE_ORIGINS = [
  "https://app.tinycloud.one",
  "tinycloudone://app.tinycloud.one",
  "https://localhost",
  "capacitor://localhost",
];

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(cors(appCorsOptions(frontendOriginsFromEnv("https://tinycloud.chat", {}))));
  app.get("/health", (_req, res) => res.json({ ok: true }));
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

describe("phone app origins", () => {
  test.each(PHONE_ORIGINS)("allows %s", async (origin) => {
    const response = await fetch(`${baseUrl}/health`, { headers: { Origin: origin } });
    expect(response.headers.get("access-control-allow-origin")).toBe(origin);
  });

  test.each(PHONE_ORIGINS)("answers the preflight for %s", async (origin) => {
    const response = await fetch(`${baseUrl}/health`, {
      method: "OPTIONS",
      headers: { Origin: origin, "Access-Control-Request-Method": "POST" },
    });
    expect(response.headers.get("access-control-allow-origin")).toBe(origin);
  });

  test.each([
    "https://evil.example",
    "http://app.tinycloud.one",
    "https://app.tinycloud.one:8443",
    "capacitor://app.tinycloud.one",
    "tinycloudone://localhost",
  ])("refuses %s", async (origin) => {
    const response = await fetch(`${baseUrl}/health`, { headers: { Origin: origin } });
    expect(response.headers.has("access-control-allow-origin")).toBe(false);
  });
});
