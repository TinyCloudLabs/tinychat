// The service's end of a sandbox's bridge: one WebSocket, given to the RPC client from bots/ as a line writer and a
// byte stream.

/** Bytes a bridge may queue that the RPC client has not read; past it the connection is closed. */
const MAX_QUEUED_BYTES = 4 * 1024 * 1024;
const RETRY_MS = 250;

export interface BridgeConnection {
  send(line: string): void;
  readonly output: ReadableStream<Uint8Array>;
  close(): void;
  /** Settles once the socket has closed, from either end. */
  readonly closed: Promise<void>;
}

const encoder = new TextEncoder();
// Bun's WebSocket constructor takes headers; the DOM lib's declaration of the same global hides that overload.
const BunWebSocket = WebSocket as unknown as new (url: string, options: Bun.WebSocketOptions) => WebSocket;

function open(url: string, token: string): Promise<BridgeConnection> {
  const { promise, resolve, reject } = Promise.withResolvers<BridgeConnection>();
  const closed = Promise.withResolvers<void>();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let ended = false;
  const output = new ReadableStream<Uint8Array>(
    { start: c => { controller = c; } },
    new ByteLengthQueuingStrategy({ highWaterMark: 64 * 1024 }),
  );
  const ws = new BunWebSocket(url, { headers: { authorization: `Bearer ${token}` } });
  ws.binaryType = "arraybuffer";
  const end = () => {
    if (ended) return;
    ended = true;
    try { controller.close(); } catch { /* already errored */ }
    closed.resolve();
  };
  ws.onopen = () => resolve({
    send: line => ws.send(line),
    output,
    close: () => ws.close(),
    closed: closed.promise,
  });
  ws.onmessage = event => {
    if (ended) return;
    const data = event.data;
    controller.enqueue(typeof data === "string" ? encoder.encode(data) : new Uint8Array(data as ArrayBuffer));
    if ((controller.desiredSize ?? 0) < -MAX_QUEUED_BYTES) {
      ended = true;
      controller.error(new Error("bridge output not read"));
      closed.resolve();
      ws.close();
    }
  };
  ws.onerror = () => reject(new Error("bridge refused the connection"));
  ws.onclose = () => {
    reject(new Error("bridge closed the connection"));
    end();
  };
  return promise;
}

/**
 * Connects to `http://<address>:<port>` of a sandbox's bridge with this launch's token, retrying until `deadline` (a
 * freshly woken sandbox's bridge may not be listening yet).
 */
export async function connectBridge(endpoint: string, token: string, deadline: number): Promise<BridgeConnection> {
  const url = `${endpoint.replace(/^http:/, "ws:")}/rpc`;
  for (;;) {
    try {
      return await open(url, token);
    } catch (error) {
      if (Date.now() + RETRY_MS > deadline) throw error;
      await Bun.sleep(RETRY_MS);
    }
  }
}
