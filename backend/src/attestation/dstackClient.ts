import { existsSync } from "fs";
import {
  createDstackUnavailableError,
  type DstackClient,
  type DstackInfo,
  type DstackQuote,
} from "./selfAttest.js";

const DEFAULT_DSTACK_SOCKET = "/var/run/dstack.sock";

type BunUnixRequestInit = RequestInit & { unix?: string };

interface RawDstackInfo {
  app_id?: unknown;
  instance_id?: unknown;
  compose_hash?: unknown;
  app_compose?: unknown;
  os_image_hash?: unknown;
  tcb_info?: unknown;
}

interface RawDstackQuote {
  quote?: unknown;
  event_log?: unknown;
}

export class DstackUnixClient implements DstackClient {
  constructor(private readonly socketPath = process.env.DSTACK_SOCKET ?? DEFAULT_DSTACK_SOCKET) {}

  async getQuote(reportDataHex: string): Promise<DstackQuote> {
    const raw = await this.request<RawDstackQuote>("/GetQuote", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ report_data: reportDataHex }),
    });
    const quote = stringField(raw.quote, "quote");
    return {
      quote,
      event_log:
        typeof raw.event_log === "string"
          ? raw.event_log
          : JSON.stringify(raw.event_log ?? null),
      report_data: reportDataHex,
    };
  }

  async info(): Promise<DstackInfo> {
    const raw = await this.request<RawDstackInfo>("/Info", { method: "GET" });
    return {
      app_id: optionalString(raw.app_id),
      instance_id: optionalString(raw.instance_id),
      compose_hash: optionalString(raw.compose_hash),
      app_compose: extractAppCompose(raw),
      os_image_hash: optionalString(raw.os_image_hash),
    };
  }

  private async request<T>(path: string, init: BunUnixRequestInit): Promise<T> {
    if (!existsSync(this.socketPath)) {
      throw createDstackUnavailableError("dstack socket is not available");
    }
    let response: Response;
    try {
      const fetchUnix = fetch as (
        input: string | URL | Request,
        init?: BunUnixRequestInit,
      ) => Promise<Response>;
      response = await fetchUnix(`http://dstack${path}`, {
        ...init,
        unix: this.socketPath,
      });
    } catch (error) {
      throw createDstackUnavailableError(errorMessage(error));
    }
    if (!response.ok) {
      throw createDstackUnavailableError(`dstack agent returned HTTP ${response.status}`);
    }
    try {
      return (await response.json()) as T;
    } catch {
      throw createDstackUnavailableError("dstack agent returned invalid JSON");
    }
  }
}

export function createDstackClient(): DstackClient {
  return new DstackUnixClient();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

// app_compose may arrive top-level (preferred — it wins) or nested inside the
// dstack guest agent's tcb_info, which is often itself a JSON string. We never
// fabricate a value: if it is absent everywhere the field stays undefined.
function extractAppCompose(raw: RawDstackInfo): string | undefined {
  const topLevel = normalizeAppCompose(raw.app_compose);
  if (topLevel !== undefined) return topLevel;
  return normalizeAppCompose(readNestedAppCompose(raw.tcb_info));
}

function normalizeAppCompose(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return undefined;
  return JSON.stringify(value);
}

function readNestedAppCompose(tcbInfo: unknown): unknown {
  let parsed: unknown = tcbInfo;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return undefined;
    }
  }
  if (parsed && typeof parsed === "object" && "app_compose" in parsed) {
    return (parsed as { app_compose?: unknown }).app_compose;
  }
  return undefined;
}

function stringField(value: unknown, field: string): string {
  if (typeof value === "string" && value.length > 0) return value;
  throw createDstackUnavailableError(`dstack agent did not return ${field}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
