import { isRecord } from "./guards";
import { MESSAGING_STRINGS } from "./messaging-strings";

// Minimal client for OMP's `--mode rpc` JSONL protocol (protocol v1; see OMP docs rpc.md).
// Everything read from the sandbox is untrusted: lines are length-capped, parsed defensively, and only
// responses to ids this client sent are matched. UI requests are refused and host tools are scoped to one turn.

export type Frame = { type: string } & Record<string, unknown>;

/** OMP v1 caps a stdout frame at 1 MiB; anything longer is a protocol violation. */
export const MAX_LINE_CHARS = 1024 * 1024;
const MAX_HOST_CALLS_PER_TURN = 256;

export interface HostToolReply { text: string; isError?: true }
export type HostToolHandler = (name: string, args: unknown, signal: AbortSignal) => Promise<HostToolReply>;

interface HostTools {
  handle: HostToolHandler;
  pending: Map<string, AbortController>;
  seen: Set<string>;
}

export class RpcError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

interface Pending {
  resolve: (data: unknown) => void;
  reject: (error: Error) => void;
  timer: Timer;
}

export class RpcChannel {
  readonly #write: (line: string) => void;
  readonly #pending = new Map<string, Pending>();
  readonly #listeners = new Set<(frame: Frame) => void>();
  readonly #ready = Promise.withResolvers<void>();
  #seq = 0;
  #closedError: Error | undefined;
  #hostTools: HostTools | undefined;
  /** Settles when stdout ends or the stream breaks the protocol. */
  readonly closed: Promise<void>;

  constructor(write: (line: string) => void, stdout: ReadableStream<Uint8Array>) {
    this.#write = write;
    this.#ready.promise.catch(() => {});
    this.closed = this.#read(stdout).then(
      () => this.#close(new Error("bot output ended")),
      (error: unknown) => this.#close(error instanceof Error ? error : new Error("bot output failed")),
    );
  }

  /** Resolves on OMP's `ready` frame. */
  ready(timeoutMs: number): Promise<void> {
    const timer = setTimeout(() => this.#ready.reject(new Error("bot did not become ready")), timeoutMs);
    return this.#ready.promise.finally(() => clearTimeout(timer));
  }

  nextId(): string {
    return `bots-${++this.#seq}`;
  }

  /** Sends one command and resolves with its response `data`; a failed response rejects with its `code`. */
  request(command: Record<string, unknown>, timeoutMs = 30_000): Promise<unknown> {
    if (this.#closedError) return Promise.reject(this.#closedError);
    const id = typeof command.id === "string" ? command.id : this.nextId();
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    const timer = setTimeout(() => {
      this.#pending.delete(id);
      reject(new RpcError(`${String(command.type)} timed out`, "timeout"));
    }, timeoutMs);
    this.#pending.set(id, { resolve, reject, timer });
    this.#send({ ...command, id });
    return promise;
  }

  onFrame(listener: (frame: Frame) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  onHostToolCall(handle: HostToolHandler): () => void {
    if (this.#hostTools) throw new Error("host tools already active");
    const tools: HostTools = { handle, pending: new Map(), seen: new Set() };
    this.#hostTools = tools;
    return () => {
      if (this.#hostTools === tools) this.#clearHostTools();
    };
  }

  #clearHostTools(): void {
    const tools = this.#hostTools;
    this.#hostTools = undefined;
    for (const call of tools?.pending.values() ?? []) call.abort();
  }

  #hostToolResult(id: string, reply: HostToolReply): void {
    if (this.#closedError) return;
    this.#send({
      type: "host_tool_result", id, result: { content: [{ type: "text", text: reply.text }] },
      ...(reply.isError ? { isError: true } : {}),
    });
  }

  #hostToolCall(frame: Record<string, unknown>): void {
    const { id, toolName } = frame;
    if (typeof id !== "string" || !id || id.length > 200) return;
    const tools = this.#hostTools;
    if (tools?.seen.has(id)) return;
    const refused = { text: MESSAGING_STRINGS.unavailable, isError: true } as const;
    if (!tools || typeof toolName !== "string" || tools.seen.size >= MAX_HOST_CALLS_PER_TURN) {
      this.#hostToolResult(id, refused);
      return;
    }
    const controller = new AbortController();
    tools.seen.add(id);
    tools.pending.set(id, controller);
    void Promise.resolve().then(() => controller.signal.aborted ? refused : tools.handle(toolName, frame.arguments, controller.signal))
      .catch(() => refused)
      .then(reply => {
        tools.pending.delete(id);
        if (!controller.signal.aborted) this.#hostToolResult(id, reply);
      });
  }

  #send(frame: Record<string, unknown>): void {
    try {
      this.#write(`${JSON.stringify(frame)}\n`);
    } catch {
      this.#close(new Error("bot input closed"));
    }
  }

  async #read(stdout: ReadableStream<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of stdout) {
      buffer += decoder.decode(chunk, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.length > MAX_LINE_CHARS) throw new Error("bot output line too long");
        this.#handle(line);
        newline = buffer.indexOf("\n");
      }
      if (buffer.length > MAX_LINE_CHARS) throw new Error("bot output line too long");
    }
  }

  #handle(line: string): void {
    if (!line.trim()) return;
    let frame: unknown;
    try {
      frame = JSON.parse(line);
    } catch {
      return;
    }
    if (!isRecord(frame) || typeof frame.type !== "string") return;
    switch (frame.type) {
      case "ready":
        this.#ready.resolve();
        return;
      case "response": {
        const pending = typeof frame.id === "string" ? this.#pending.get(frame.id) : undefined;
        if (!pending) return;
        this.#pending.delete(frame.id as string);
        clearTimeout(pending.timer);
        if (frame.success === true) pending.resolve(frame.data);
        else pending.reject(new RpcError("bot command failed", typeof frame.code === "string" ? frame.code : undefined));
        return;
      }
      case "extension_ui_request":
        if (typeof frame.id === "string" && frame.id.length <= 200) {
          this.#send({ type: "extension_ui_response", id: frame.id, cancelled: true });
        }
        return;
      case "host_tool_call":
        this.#hostToolCall(frame);
        return;
      case "host_tool_cancel":
        if (typeof frame.targetId === "string") this.#hostTools?.pending.get(frame.targetId)?.abort();
        return;
      case "host_uri_request":
      case "host_uri_cancel":
        return;
    }
    for (const listener of this.#listeners) listener(frame as Frame);
  }

  #close(error: Error): void {
    if (this.#closedError) return;
    this.#closedError = error;
    this.#clearHostTools();
    this.#ready.reject(error);
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}
