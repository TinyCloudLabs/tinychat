import { DEFAULT_REQUEST_HEADER_NAME, DEFAULT_REQUEST_HEADER_VALUE, SessionStore } from "@tinyboilerplate/client";
import type { ReadArea } from "./trustbotReadAreas";

export interface StandingReadsView {
  areas: ReadArea[];
  active: { originalCid: string; areas: ReadArea[]; validUntil: number } | null;
  pending: { approveUrl: string } | null;
  previousOriginalCid: string | null;
  outcome: "declined" | "expired" | "failed" | null;
}

const backend = import.meta.env.VITE_BACKEND_URL || `${globalThis.location?.protocol ?? "http:"}//localhost:3014`;
const route = `${backend}/api/bots/main/reads/standing`;

async function request(method: "GET" | "POST" | "DELETE", cid?: string): Promise<Response> {
  const token = new SessionStore("xyz.tinycloud.tinychat:session").getToken();
  if (!token) throw new Error("signed_out");
  const response = await fetch(cid ? `${route}/${encodeURIComponent(cid)}` : route, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      [DEFAULT_REQUEST_HEADER_NAME]: DEFAULT_REQUEST_HEADER_VALUE,
    },
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok && response.status !== 404) throw new Error("standing_reads_unavailable");
  return response;
}

export async function standingReadsView(method: "GET" | "POST" = "GET"): Promise<StandingReadsView | null> {
  const response = await request(method);
  return response.status === 404 ? null : response.json();
}

export async function stopStandingReads(cid: string, revoke: (originalCid: string) => Promise<void>): Promise<void> {
  await revoke(cid);
  const response = await request("DELETE", cid);
  if (!response.ok) throw new Error("standing_reads_unavailable");
}

export async function stopStandingArea(area: ReadArea, revoke: (originalCid: string) => Promise<void>): Promise<void> {
  const saved = await standingReadsView();
  if (!saved?.active?.areas.includes(area)) return;
  if (saved.previousOriginalCid) await stopStandingReads(saved.previousOriginalCid, revoke);
  await stopStandingReads(saved.active.originalCid, revoke);
}
