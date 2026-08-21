import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import cors from "cors";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { appCorsOrigins, EXO_DESKTOP_ORIGIN } from "../cors-origins.js";

const WEB_ORIGIN = "https://tinycloud.chat";

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(cors({ origin: appCorsOrigins(WEB_ORIGIN) }));
  app.get("/health", (_req, res) => res.json({ ok: true }));

  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

describe("app CORS origins", () => {
  test.each([WEB_ORIGIN, EXO_DESKTOP_ORIGIN])("allows %s", async (origin) => {
    const response = await fetch(`${baseUrl}/health`, {
      headers: { Origin: origin },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe(origin);
  });

  test("does not allow an unrelated web origin", async () => {
    const response = await fetch(`${baseUrl}/health`, {
      headers: { Origin: "https://attacker.example" },
    });

    expect(response.status).toBe(200);
    expect(response.headers.has("access-control-allow-origin")).toBe(false);
  });

  test("allows the desktop verify preflight and its CSRF header", async () => {
    const response = await fetch(`${baseUrl}/health`, {
      method: "OPTIONS",
      headers: {
        Origin: EXO_DESKTOP_ORIGIN,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type,x-requested-with",
      },
    });

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(EXO_DESKTOP_ORIGIN);
    expect(response.headers.get("access-control-allow-headers")).toContain("x-requested-with");
  });
});
