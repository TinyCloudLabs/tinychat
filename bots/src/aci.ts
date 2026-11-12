// Model receipt audit using the same ACI connection and verdict contract as TC-2196 / tinychat #623.
import { connectAci } from "@phala/aci-verifier/runtime";
import type { AciConnection } from "@phala/aci-verifier/runtime";

export class BotAci {
  #connection: Promise<AciConnection> | undefined;
  readonly #receipts = new Map<string, unknown[]>();
  constructor(readonly origin: string, readonly connect = connectAci) {
    if (origin !== "https://tee.redpill.ai") throw new Error("invalid_aci_origin");
  }
  take(botId: string): unknown[] {
    const receipts = this.#receipts.get(botId) ?? [];
    this.#receipts.delete(botId);
    return receipts;
  }
  async fetch(botId: string, url: string, init: RequestInit): Promise<Response> {
    this.#connection ??= this.connect({ baseURL: this.origin + "/v1", serving: { requireVerified: true, requireReceipt: true }, receiptHistorySize: 1000 })
      .then(aci => { if (aci.identity.transcript.verdict.verified !== true) throw new Error("aci_identity_unverified"); return aci; })
      .catch(error => { this.#connection = undefined; throw error; });
    const aci = await this.#connection;
    const response = await aci.fetch(url, init);
    if (!response.ok) return response;
    const receiptId = response.headers.get("x-receipt-id");
    const record = (verified: boolean) => {
      const receipts = this.#receipts.get(botId) ?? [];
      if (receipts.length >= 64) throw new Error("receipt_capacity");
      receipts.push({ receiptId: receiptId ?? null, verified }); this.#receipts.set(botId, receipts);
    };
    if (!receiptId || !response.body) { record(false); await response.body?.cancel(); throw new Error("model_receipt_missing"); }
    // Buffer before handing a complete model response to OMP. This also prevents unverified tool execution.
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    const verified = async () => {
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > 8 * 1024 * 1024) throw new Error("model_response_limit");
        chunks.push(chunk.value);
      }
      let timer: Timer | undefined;
      try {
        const audit = await Promise.race([aci.verifyReceipt(receiptId), new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("model_receipt_timeout")), 5000);
        })]);
        if (init.signal?.aborted || audit.transcript.verdict.verified !== true) throw new Error("model_receipt_unverified");
      } finally { clearTimeout(timer); }
      const text = Buffer.concat(chunks).toString("utf8");
      if (response.headers.get("content-type")?.includes("text/event-stream") && !/(?:^|\n)data:\s*\[DONE\](?:\r?\n|$)/.test(text)) throw new Error("model_response_incomplete");
      record(true);
      // No upstream verification frame is an authority signal. OMP sees only audited model protocol data.
      const body = text.split(/\r?\n\r?\n/).filter(frame => {
        if (/^event:\s*tinycloud\.receipt-verification\s*$/m.test(frame)) return false;
        const data = frame.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trim()).join("\n");
        try { const parsed = JSON.parse(data); return !Object.hasOwn(parsed, "receipt_verification"); } catch { return true; }
      }).join("\n\n");
      return body;
    } catch (error) { record(false); await reader.cancel().catch(() => {}); throw error; }
    finally { reader.releaseLock(); }
    };
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        void verified().then(text => { controller.enqueue(new TextEncoder().encode(text)); controller.close(); }, error => controller.error(error));
      },
      cancel(reason) { return reader.cancel(reason); },
    });
    return new Response(stream, { status: response.status, headers: { "content-type": response.headers.get("content-type") ?? "application/json" } });
  }
}
