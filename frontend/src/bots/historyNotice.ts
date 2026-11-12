import { DEFAULT_REQUEST_HEADER_NAME, DEFAULT_REQUEST_HEADER_VALUE, SessionStore } from "@tinyboilerplate/client";
export interface HistoryNotice { id: string; expiresAt: number; firstAttemptAt: number; deliveredAt?: number; deleteAt?: number; renderAttemptAt?: number }
const base = import.meta.env.VITE_BACKEND_URL || `${globalThis.location?.protocol ?? "http:"}//localhost:3014`;
async function request(method: string, path: string, body?: unknown) {
  const token = new SessionStore("xyz.tinycloud.tinychat:session").getToken();
  if (!token) throw new Error("history_signed_out");
  return fetch(base + "/api/bots/history/notice" + path, { method, headers: { authorization: `Bearer ${token}`,
    [DEFAULT_REQUEST_HEADER_NAME]: DEFAULT_REQUEST_HEADER_VALUE, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined, cache: "no-store", signal: AbortSignal.timeout(10_000) });
}
export async function readHistoryNotice(): Promise<HistoryNotice | null> {
  const response = await request("GET", "");
  if (response.status === 404) return null;
  if (!response.ok) throw new Error("history_notice_unavailable");
  const notice = (await response.json()).notice as HistoryNotice | null;
  return notice ? { ...notice, renderAttemptAt: Date.now() } : null;
}
export function historyNoticeDeadline(notice: HistoryNotice, renderedAt: number): number {
  if (notice.deleteAt !== undefined) return notice.deleteAt;
  const base = Math.max(notice.expiresAt, notice.firstAttemptAt) + 30 * 86_400_000;
  return renderedAt > base ? renderedAt + 30 * 86_400_000 : base;
}
export async function acknowledgeHistoryNotice(notice: HistoryNotice, renderedAt: number): Promise<HistoryNotice> {
  const response = await request("POST", "/ack", { id: notice.id, renderedAt });
  if (!response.ok) throw new Error("history_notice_unavailable");
  return (await response.json()).notice as HistoryNotice;
}
