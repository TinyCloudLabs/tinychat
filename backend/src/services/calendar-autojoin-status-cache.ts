export interface CalendarAutojoinStatus {
  state: "off" | "on" | "needs_reconnect" | "error";
  enabled: boolean;
  lastScanAt: number | null;
  lastDispatchLag: { sentAt: number; seconds: number; discovered: number } | null;
  errorCode: string | null;
  outcomes: { id: string; title: string; start: number; reason: string; meetingId?: string }[];
}

export const STATUS_CACHE_MAX_TENANTS = 1_000;
export const STATUS_CACHE_MAX_AGE_MS = 30 * 60_000;

/** Process-local last-good responses. All stores for one backend node share this instance. */
export class CalendarAutojoinStatusCache {
  private readonly entries = new Map<string, { body: CalendarAutojoinStatus; at: number }>();
  private readonly reading = new Map<string, Set<{ valid: boolean }>>();

  constructor(private readonly now: () => number = Date.now) {}

  get(tenant: string): { body: CalendarAutojoinStatus; asOf: string } | undefined {
    const key = tenant.toLowerCase();
    const entry = this.entries.get(key);
    if (!entry) return;
    if (this.now() - entry.at >= STATUS_CACHE_MAX_AGE_MS) {
      this.entries.delete(key);
      return;
    }
    // Serving a fallback makes this tenant most recently used, without extending its age.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return { body: structuredClone(entry.body), asOf: new Date(entry.at).toISOString() };
  }

  async refresh(tenant: string, read: () => Promise<CalendarAutojoinStatus>): Promise<CalendarAutojoinStatus> {
    const key = tenant.toLowerCase();
    const token = { valid: true };
    const readers = this.reading.get(key) ?? new Set<{ valid: boolean }>();
    readers.add(token);
    this.reading.set(key, readers);
    try {
      const body = await read();
      // A read that overlaps a mutation must never restore the pre-mutation response.
      if (token.valid) {
        this.entries.delete(key);
        this.entries.set(key, { body: structuredClone(body), at: this.now() });
        if (this.entries.size > STATUS_CACHE_MAX_TENANTS) this.entries.delete(this.entries.keys().next().value!);
      }
      return body;
    } finally {
      readers.delete(token);
      if (readers.size === 0) this.reading.delete(key);
    }
  }

  private invalidate(tenant: string): void {
    const key = tenant.toLowerCase();
    this.entries.delete(key);
    for (const token of this.reading.get(key) ?? []) token.valid = false;
  }

  async mutate<T>(tenant: string, write: () => Promise<T>): Promise<T> {
    this.invalidate(tenant);
    try { return await write(); }
    // Invalidate even on ambiguous write failure, and discard reads started during the write.
    finally { this.invalidate(tenant); }
  }
}
