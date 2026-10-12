import express from "express";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { createTranscriberRouter } from "../../routes/transcriber.js";
import { BackendStorageLane } from "../../services/backend-storage-lane.js";
import { JsonTranscriberIndexStore, type JsonKv } from "../../services/transcriber-index.js";
import { createTranscriptionApiClient } from "../../services/transcription-api.js";

/** The index is persisted across process death, not shared through an in-memory fake. */
export class FileJsonKv implements JsonKv {
  constructor(private readonly filename: string, private readonly crashAt?: "complete") {}

  private rows(): Record<string, unknown> {
    try {
      return JSON.parse(readFileSync(this.filename, "utf8")) as Record<string, unknown>;
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return {};
      throw error;
    }
  }

  async get<T>(key: string): Promise<T | null> {
    return structuredClone(this.rows()[key] ?? null) as T | null;
  }

  async put(key: string, value: unknown): Promise<void> {
    if (this.crashAt === "complete" && value && typeof value === "object"
      && "ids" in value && Array.isArray(value.ids) && value.ids.length > 0
      && "pending" in value && Array.isArray(value.pending) && value.pending.length === 0) {
      process.kill(process.pid, "SIGKILL");
      throw new Error("SIGKILL did not terminate the child");
    }
    this.persist({ ...this.rows(), [key]: structuredClone(value) });
  }

  async remove(key: string): Promise<void> {
    const rows = this.rows();
    delete rows[key];
    this.persist(rows);
  }

  async keys(prefix: string): Promise<string[]> {
    return Object.keys(this.rows()).filter(key => key.startsWith(prefix));
  }

  private persist(rows: Record<string, unknown>): void {
    writeFileSync(`${this.filename}.tmp`, JSON.stringify(rows));
    renameSync(`${this.filename}.tmp`, this.filename);
  }
}

if (import.meta.main) {
  const { CRASH_INDEX_FILE, CRASH_PTX_URL, CRASH_AT, CRASH_OWNER_ADDRESS } = process.env;
  if (!CRASH_INDEX_FILE || !CRASH_PTX_URL || !CRASH_OWNER_ADDRESS || CRASH_AT !== "complete") {
    throw new Error("Missing crash fixture configuration");
  }
  const api = createTranscriptionApiClient({ baseUrl: CRASH_PTX_URL, apiKey: "fixture-only" });
  const index = new JsonTranscriberIndexStore(new FileJsonKv(CRASH_INDEX_FILE, CRASH_AT), new BackendStorageLane());
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { address: CRASH_OWNER_ADDRESS };
    next();
  });
  app.use("/api/transcriber/meetings", createTranscriberRouter({ api, index }));
  const server = app.listen(0, "127.0.0.1", async () => {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing child port");
    await fetch(`http://127.0.0.1:${address.port}/api/transcriber/meetings`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ meeting_url: "https://meet.jit.si/crash-window" }),
    });
    process.exitCode = 2; // The fixture must die before the route can respond.
    server.close();
  });
}
