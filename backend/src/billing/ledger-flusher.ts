// §E.6 — LedgerFlusher: async shadow-push of usage records to the credit ledger.
// enqueue() is synchronous and cheap — never blocks serving.
// The flush is a background timer; a ledger outage grows the outbox and never
// touches the request path (spec constraint #4).

export interface LedgerUsageRecord {
  record_id: string;
  account: string;
  window_start: number;
  window_kind: "utc_day" | "anchored_week" | "calendar_month";
  credits: number;
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
  occurred_at: number;
  signed_token_count: string | null;
}

export type LedgerUsageRecordInput = Omit<LedgerUsageRecord, "record_id">;

const OUTBOX_CAP = 5000;
const FLUSH_INTERVAL_MS = 5000;
const FLUSH_SIZE_TRIGGER = 50;

export class LedgerFlusher {
  private outbox: LedgerUsageRecord[] = [];
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private flushing = false;
  private readonly serviceUrl: string;
  private readonly serviceSecret: string;

  constructor(serviceUrl: string, serviceSecret: string) {
    this.serviceUrl = serviceUrl.replace(/\/$/, "");
    this.serviceSecret = serviceSecret;
  }

  enqueue(record: LedgerUsageRecordInput): void {
    if (this.outbox.length >= OUTBOX_CAP) {
      console.warn(
        `[ledger-flusher] outbox at cap (${OUTBOX_CAP}); dropping oldest record`,
      );
      this.outbox.shift();
    }
    this.outbox.push({ ...record, record_id: crypto.randomUUID() });
    if (this.outbox.length >= FLUSH_SIZE_TRIGGER) {
      this.flush().catch((err) => {
        console.error("[ledger-flusher] size-trigger flush error:", err);
      });
    }
  }

  async flush(): Promise<void> {
    if (this.flushing || this.outbox.length === 0) return;
    this.flushing = true;
    try {
      const batch = this.outbox.slice();
      const reportId = crypto.randomUUID();
      let res: Response;
      try {
        res = await fetch(`${this.serviceUrl}/api/usage/ingest`, {
          method: "POST",
          signal: AbortSignal.timeout(10000),
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.serviceSecret}`,
          },
          body: JSON.stringify({ report_id: reportId, records: batch }),
        });
      } catch (err) {
        console.warn("[ledger-flusher] flush failed (network):", err);
        return;
      }
      if (res.ok) {
        const batchIds = new Set(batch.map((r) => r.record_id));
        this.outbox = this.outbox.filter((r) => !batchIds.has(r.record_id));
      } else {
        console.warn(`[ledger-flusher] flush failed (HTTP ${res.status})`);
      }
    } finally {
      this.flushing = false;
    }
  }

  start(): void {
    if (this.intervalId !== null) return;
    this.intervalId = setInterval(() => {
      this.flush().catch((err) => {
        console.error("[ledger-flusher] interval flush error:", err);
      });
    }, FLUSH_INTERVAL_MS);
    const id = this.intervalId as unknown as { unref?: () => void };
    id.unref?.();
  }

  stop(): void {
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  get outboxSize(): number {
    return this.outbox.length;
  }
}
