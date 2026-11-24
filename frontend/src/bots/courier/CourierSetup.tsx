import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { DEFAULT_REQUEST_HEADER_NAME, DEFAULT_REQUEST_HEADER_VALUE, SessionStore } from "@tinyboilerplate/client";

import { Button } from "@/components/ui/button";
import { BotsError, BotsRouteMissing } from "../botsApi";
import { CourierPeers } from "./CourierPeers";

// Monica's Courier setup copy, including the paste-back approval step.
const COPY = {
  title: "Connect your agents to TrustBot",
  intro: "Agents you pair with TrustBot can ask it questions over Courier. TrustBot answers with what you let it read and takes no actions.",
  connect: "Connect TrustBot to Courier",
  pending: "Approve the request in OpenKey. OpenKey shows a code when you're done: copy it and paste it here.",
  connected: "Connected until {date}.",
  expiring: "The connection ends on {date}. Renew it to keep your agents connected.",
  renew: "Renew connection",
  expired: "The connection ended on {date}. Connect TrustBot to keep answering your agents.",
  declined: "The connection wasn't approved. Nothing changed.",
  failed: "TrustBot couldn't connect to Courier. Try again.",
  code: "Code from OpenKey",
  finish: "Finish connecting",
  cancel: "Cancel",
  badCode: "This code didn't work. Approve the request in OpenKey and paste the new code.",
  reason: "TrustBot answers agents you pair with it over Courier, using only what you let it read.",
};

export interface CourierIdentity {
  did: string;
  publicJwk: JsonWebKey;
  /** Generated from the pinned Courier library in the TEE, not a second frontend manifest. */
  request: {
    host: string;
    expiry: string;
    permissions: { service: string; space: string; path: string; actions: string[] }[];
  };
}

export interface CourierGrant {
  raw: Record<string, unknown>;
  expiresAt: number;
}

type GrantStatus = { expiresAt: number | null };
export interface CourierSetupApi {
  owner: string;
  readIdentity(): Promise<CourierIdentity>;
  readGrant(): Promise<GrantStatus>;
  redeemCode(code: string): Promise<unknown>;
  saveGrant(grant: CourierGrant): Promise<GrantStatus>;
}

const MAX_GRANT_MS = 30 * 86_400_000;
const RENEW_BEFORE_MS = 3 * 86_400_000;
const PRIVATE_JWK_FIELDS = ["d", "p", "q", "dp", "dq", "qi", "oth", "k"];
const OPENKEY_HOST = import.meta.env.VITE_OPENKEY_HOST || "https://openkey.so";
const OPENKEY_API_HOST = new URL(OPENKEY_HOST).origin === "https://openkey.so" ? "https://api.openkey.so" : new URL(OPENKEY_HOST).origin;
const BACKEND = import.meta.env.VITE_BACKEND_URL || `${globalThis.location?.protocol ?? "http:"}//localhost:3014`;
const ROOT = "/api/bots/main/courier";
const sessionStore = () => new SessionStore("xyz.tinycloud.tinychat:session");
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const base64url = (value: unknown) => btoa(Array.from(new TextEncoder().encode(JSON.stringify(value)), (byte) => String.fromCharCode(byte)).join("")).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** Browser equivalent of Courier's openKeyDelegateUrl; only the public TEE key leaves the service. */
export function courierApprovalUrl(identity: CourierIdentity, openkeyHost = OPENKEY_HOST): string {
  const { publicJwk: jwk, request } = identity;
  if (!identity.did.startsWith("did:key:") || jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || !jwk.x
    || PRIVATE_JWK_FIELDS.some((field) => field in jwk) || request.expiry !== "30d"
    || !Array.isArray(request.permissions) || request.permissions.length === 0) throw new Error("courier_identity_invalid");
  const url = new URL("/delegate", openkeyHost);
  url.search = new URLSearchParams({
    did: identity.did, host: request.host, reason: COPY.reason, expiry: request.expiry, protocolVersion: "1",
    jwk: base64url({ kty: jwk.kty, crv: jwk.crv, x: jwk.x }),
    permissions: base64url({ permissions: request.permissions, reason: COPY.reason }),
  }).toString();
  return url.toString();
}

/** Keep the signed OpenKey object untouched; the TEE verifies signatures and the exact manifest on PUT. */
export function parseCourierGrant(input: unknown, identity: CourierIdentity, owner: string, now = Date.now()): CourierGrant {
  let value = input;
  if (typeof value === "string") {
    const text = value.trim();
    try { value = JSON.parse(text); }
    catch { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), (char) => char.charCodeAt(0)))); }
  }
  const raw = object(value);
  const jwk = object(raw.jwk);
  const strings = ["delegationCid", "spaceId", "address", "siwe", "signature", "verificationMethod"];
  if (strings.some((field) => typeof raw[field] !== "string" || !raw[field])
    || typeof object(raw.delegationHeader).Authorization !== "string" || !object(raw.delegationHeader).Authorization
    || !Number.isInteger(raw.chainId) || Number(raw.chainId) <= 0
    || String(raw.address).toLowerCase() !== owner.toLowerCase()
    || String(raw.verificationMethod).split("#")[0] !== identity.did
    || jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || jwk.x !== identity.publicJwk.x
    || PRIVATE_JWK_FIELDS.some((field) => field in jwk)) throw new Error("courier_grant_invalid");
  const siwe = raw.siwe as string;
  const issuedAt = Date.parse(/^Issued At:\s*(\S+)/im.exec(siwe)?.[1] ?? "");
  const expiresAt = Date.parse(/^Expiration Time:\s*(\S+)/im.exec(siwe)?.[1] ?? "");
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || expiresAt <= now || expiresAt <= issuedAt
    || expiresAt - issuedAt > MAX_GRANT_MS || expiresAt - now > MAX_GRANT_MS) throw new Error("courier_grant_expired");
  return { raw, expiresAt };
}

/** Bind every read, redemption and upload to the owner session that opened this settings section. */
function createApi(): CourierSetupApi {
  const sessions = sessionStore();
  const token = sessions.getToken();
  const owner = sessions.getAddress()?.toLowerCase() ?? "";
  const assertSession = () => {
    const current = sessionStore();
    if (!token || !owner || current.getToken() !== token || current.getAddress()?.toLowerCase() !== owner) throw new BotsError("signed_out");
  };
  const request = async (path: string, grant?: CourierGrant): Promise<unknown> => {
    assertSession();
    const response = await fetch(`${BACKEND}${ROOT}${path}`, {
      method: grant ? "PUT" : "GET",
      headers: { authorization: `Bearer ${token}`, [DEFAULT_REQUEST_HEADER_NAME]: DEFAULT_REQUEST_HEADER_VALUE, ...(grant ? { "content-type": "application/json" } : {}) },
      body: grant ? JSON.stringify(grant) : undefined,
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    assertSession();
    if (response.status === 404) throw new BotsRouteMissing();
    if (response.status === 401) throw new BotsError("signed_out");
    if (!response.ok) throw new BotsError(response.status === 400 ? "invalid" : "failed");
    return response.json();
  };
  const status = (payload: unknown): GrantStatus => {
    const expiresAt = object(payload).expiresAt;
    if (expiresAt !== null && (typeof expiresAt !== "number" || !Number.isFinite(expiresAt))) throw new BotsError("failed");
    return { expiresAt: expiresAt as number | null };
  };
  return {
    owner,
    readIdentity: async () => {
      const identity = await request("/identity") as CourierIdentity;
      // Verify the public request shape before showing a link; backend chooses the node and exact pinned manifest.
      courierApprovalUrl(identity);
      return identity;
    },
    readGrant: async () => status(await request("/grant")),
    saveGrant: async (grant) => {
      const saved = status(await request("/grant", grant));
      if (saved.expiresAt === null || saved.expiresAt <= Date.now()) throw new BotsError("failed");
      return saved;
    },
    redeemCode: async (code) => {
      assertSession();
      const response = await fetch(`${OPENKEY_API_HOST}/api/delegation-codes/${code.trim().toLowerCase()}`, {
        credentials: "omit", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(10_000),
      });
      assertSession();
      if (!response.ok) throw new Error("courier_code_invalid");
      return object(await response.json()).delegation;
    },
  };
}

/** Hidden on a gated 404. Approval is always an owner action, including renewal before the signed grant ends. */
export function CourierSetup({ api: suppliedApi }: { api?: CourierSetupApi }) {
  const [api] = useState(() => suppliedApi ?? createApi());
  const id = useId();
  const [loaded, setLoaded] = useState<{ identity: CourierIdentity; grant: GrantStatus } | null>(null);
  const [missing, setMissing] = useState(false);
  const [pending, setPending] = useState(false);
  const [code, setCode] = useState("");
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<"failed" | "badCode" | "declined" | null>(null);
  const [now, setNow] = useState(Date.now);
  const alive = useRef(true);
  const inFlight = useRef(false);
  // Short codes are single-use. Retain a redeemed grant in memory so a failed PUT can be retried without redeeming it twice.
  const redeemed = useRef<{ code: string; raw: unknown } | null>(null);
  useEffect(() => {
    alive.current = true;
    const tick = setInterval(() => setNow(Date.now()), 60_000);
    Promise.all([api.readIdentity(), api.readGrant()]).then(
      ([identity, grant]) => { if (alive.current) setLoaded({ identity, grant }); },
      (error: unknown) => {
        if (!alive.current) return;
        if (error instanceof BotsRouteMissing) setMissing(true);
        else setNotice("failed");
      },
    );
    return () => { alive.current = false; clearInterval(tick); };
  }, [api]);

  if (missing || (!loaded && !notice)) return null;
  const expiresAt = loaded?.grant.expiresAt ?? null;
  const connected = expiresAt !== null && expiresAt > now;
  const expiring = connected && expiresAt - now <= RENEW_BEFORE_MS;
  const date = expiresAt === null ? "" : new Date(expiresAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  const line = expiresAt === null ? null : (connected ? expiring ? COPY.expiring : COPY.connected : COPY.expired).replace("{date}", date);

  const finish = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!loaded || inFlight.current || !code.trim()) return;
    inFlight.current = true;
    setSaving(true);
    setNotice(null);
    let uploading = false;
    try {
      const input = code.trim();
      let raw: unknown = input;
      if (/^[a-z2-7]{4}-[a-z2-7]{4}$/i.test(input)) {
        raw = redeemed.current?.code.toLowerCase() === input.toLowerCase() ? redeemed.current.raw : await api.redeemCode(input);
        redeemed.current = { code: input, raw };
      }
      const grant = parseCourierGrant(raw, loaded.identity, api.owner);
      uploading = true;
      const saved = await api.saveGrant(grant);
      if (!alive.current) return;
      setLoaded({ identity: loaded.identity, grant: saved });
      setNow(Date.now());
      setPending(false);
      setCode("");
      redeemed.current = null;
    } catch {
      if (alive.current) setNotice(uploading ? "failed" : "badCode");
    } finally {
      inFlight.current = false;
      if (alive.current) setSaving(false);
    }
  };

  return (
    <section aria-labelledby={`${id}-title`} className="flex flex-col gap-3" data-courier-setup="">
      <div className="flex flex-col gap-1">
        <h2 id={`${id}-title`} className="text-headline">{COPY.title}</h2>
        <p className="text-callout text-muted-foreground">{COPY.intro}</p>
        {line ? <p className="text-callout text-muted-foreground" aria-live="polite">{line}</p> : null}
      </div>
      {loaded && (!connected || expiring || pending) ? (
        <div>
          <Button asChild type="button" variant="outline" size="sm">
            <a href={courierApprovalUrl(loaded.identity)} target="_blank" rel="noopener noreferrer" onClick={() => { setPending(true); setNotice(null); }}>
              {connected ? COPY.renew : COPY.connect}
            </a>
          </Button>
        </div>
      ) : null}
      {loaded && pending ? (
        <form onSubmit={(event) => void finish(event)} className="flex flex-col gap-3 rounded-xl border border-border bg-muted p-4" aria-busy={saving}>
          <p id={`${id}-instructions`} className="text-callout text-muted-foreground">{COPY.pending}</p>
          <label htmlFor={`${id}-code`} className="text-callout font-medium">{COPY.code}</label>
          <textarea id={`${id}-code`} value={code} onChange={(event) => setCode(event.target.value)} aria-describedby={`${id}-instructions`} autoComplete="off" autoCapitalize="none" spellCheck={false} disabled={saving} rows={3} maxLength={1_048_576}
            className="w-full resize-y rounded-lg border border-border bg-background p-3 font-mono text-callout focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" />
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={saving || !code.trim()}>{COPY.finish}</Button>
            <Button type="button" variant="outline" disabled={saving} onClick={() => { setPending(false); setCode(""); redeemed.current = null; setNotice("declined"); }}>{COPY.cancel}</Button>
          </div>
        </form>
      ) : null}
      {notice ? <p role={notice === "declined" ? "status" : "alert"} className="text-callout text-muted-foreground">{COPY[notice]}</p> : null}
      {connected ? <CourierPeers /> : null}
    </section>
  );
}
