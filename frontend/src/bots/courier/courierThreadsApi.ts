import { DEFAULT_REQUEST_HEADER_NAME, DEFAULT_REQUEST_HEADER_VALUE, SessionStore } from "@tinyboilerplate/client";

export interface CourierThreadSummary { id: string; peer: string; title: string; updatedAt: number }
export interface CourierThreadView { id: string; peer: string; title: string; messages: Array<{ role: "peer" | "bot"; text: string; at: number }> }
export interface CourierThreadsApi {
  /** null means Courier is dark for this account. */
  list(signal?: AbortSignal): Promise<CourierThreadSummary[] | null>;
  read(id: string, signal?: AbortSignal): Promise<CourierThreadView>;
  remove(id: string): Promise<void>;
  unpair(handle: string): Promise<void>;
}
const ROOT = "/api/bots/main/courier";
const ID = /^[0-9a-f]{64}$/;

export function createCourierThreadsApi(baseUrl: string, token: () => string | null | undefined, send: typeof fetch = (url, init) => globalThis.fetch(url, init)): CourierThreadsApi {
  const request = (method: "GET" | "DELETE", path: string, signal?: AbortSignal) => {
    const bearer = token();
    if (!bearer) throw new Error("signed_out");
    return send(`${baseUrl.replace(/\/$/, "")}${ROOT}${path}`, { method, signal, cache: "no-store", headers: { authorization: `Bearer ${bearer}`, [DEFAULT_REQUEST_HEADER_NAME]: DEFAULT_REQUEST_HEADER_VALUE } });
  };
  const path = (id: string) => { if (!ID.test(id)) throw new Error("invalid_thread"); return `/threads/${id}`; };
  return {
    async list(signal) {
      const response = await request("GET", "/threads", signal);
      if (response.status === 404) return null;
      if (!response.ok) throw new Error("courier_unavailable");
      const body = await response.json();
      if (!body || !Array.isArray(body.threads)) throw new Error("courier_unavailable");
      return body.threads.filter((thread: CourierThreadSummary) => thread && ID.test(thread.id) && typeof thread.peer === "string" && typeof thread.title === "string" && Number.isFinite(thread.updatedAt));
    },
    async read(id, signal) {
      const response = await request("GET", path(id), signal);
      if (!response.ok) throw new Error("courier_unavailable");
      const body = await response.json();
      if (!body || body.id !== id || typeof body.peer !== "string" || typeof body.title !== "string" || !Array.isArray(body.messages) || !body.messages.every((m: CourierThreadView["messages"][number]) => m && (m.role === "peer" || m.role === "bot") && typeof m.text === "string" && Number.isFinite(m.at))) throw new Error("courier_unavailable");
      return { id: body.id, title: body.title, peer: body.peer, messages: body.messages };
    },
    async remove(id) {
      if (!(await request("DELETE", path(id))).ok) throw new Error("courier_unavailable");
    },
    async unpair(handle) {
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(handle)) throw new Error("invalid_peer");
      if (!(await request("DELETE", `/peers/${encodeURIComponent(handle)}`)).ok) throw new Error("courier_unavailable");
    },
  };
}
const BACKEND = import.meta.env.VITE_BACKEND_URL || `${globalThis.location?.protocol ?? "http:"}//localhost:3014`;
export const courierThreadsApi = createCourierThreadsApi(BACKEND, () => new SessionStore("xyz.tinycloud.tinychat:session").getToken());
