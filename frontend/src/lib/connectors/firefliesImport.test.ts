import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PermissionEntry, TinyCloudWeb } from "@tinycloud/web-sdk";

import type { ConnectorWebhooksResult } from "./webhooksApi";
import {
  FIREFLIES_MEETINGS_KV_PREFIX,
  FIREFLIES_SECRET_KEY_PATH,
  FIREFLIES_SECRET_KV_PATH,
  firefliesGrantCids,
  firefliesImportDue,
  firefliesImportPhase,
  firefliesMeetingsGrantEntries,
  firefliesSecretsGrantEntries,
  readFirefliesImportWanted,
  renewFirefliesImportIfDue,
  replaceFirefliesImportGrants,
  sessionCanExtend,
  signFirefliesImportGrants,
  turnOffFirefliesImport,
  turnOnFirefliesImport,
  writeFirefliesImportWanted,
  FirefliesImportSignError,
  type FirefliesImportApi,
  type FirefliesImportGrants,
  type FirefliesImportStatus,
} from "./firefliesImport";

const OWNER = "0x1111111111111111111111111111111111111111";
const DELEGATE = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 22, 17, 30, 0);

describe("the two permissions match what the backend accepts", () => {
  const verifier = readFileSync(join(import.meta.dir, "../../../../backend/src/fireflies-import-verify.ts"), "utf8");
  const constant = (name: string) => new RegExp(`export const ${name} = "([^"]+)"`).exec(verifier)?.[1];

  test("paths", () => {
    expect(FIREFLIES_SECRET_KV_PATH).toBe(constant("FIREFLIES_SECRET_KV_PATH"));
    expect(FIREFLIES_SECRET_KEY_PATH).toBe(constant("FIREFLIES_SECRET_ENCRYPTION_KEY_PATH"));
    expect(verifier).toContain("export const FIREFLIES_APPLICATIONS_KV_PREFIX = `${APP_ID}/connectors/fireflies/`;");
    expect(FIREFLIES_MEETINGS_KV_PREFIX).toBe("xyz.tinycloud.tinychat/connectors/fireflies/");
  });

  test("grant one reads the one secret and opens its one key; grant two only writes meetings", () => {
    const secrets = firefliesSecretsGrantEntries(OWNER);
    expect(secrets.map(({ service, space, path, actions }) => ({ service, space, path, actions }))).toEqual([
      { service: "tinycloud.kv", space: "secrets", path: "vault/secrets/FIREFLIES_API_KEY", actions: ["get"] },
      {
        service: "tinycloud.encryption",
        space: undefined,
        path: `urn:tinycloud:encryption:did:pkh:eip155:1:${OWNER}:default/secrets/fireflies_api_key`,
        actions: ["decrypt"],
      },
    ]);
    expect(firefliesMeetingsGrantEntries().map(({ service, space, path, actions }) => ({ service, space, path, actions }))).toEqual([
      { service: "tinycloud.kv", space: "applications", path: "xyz.tinycloud.tinychat/connectors/fireflies/", actions: ["put"] },
    ]);
  });

  test("the approval screen reads in the copy owner's words", () => {
    const lines = [...firefliesSecretsGrantEntries(OWNER), ...firefliesMeetingsGrantEntries()].map((entry) => entry.description);
    expect(new Set(lines)).toEqual(
      new Set([
        "Let our server open your Fireflies key to import meetings, for up to 7 days",
        "Let our server save meetings into your Fireflies folder, for up to 7 days",
      ]),
    );
  });
});

function siweEndingIn(ms: number): string {
  return `Expiration Time: ${new Date(Date.now() + ms).toISOString()}`;
}

function signingSetup(options: { allowed?: boolean; prompted?: boolean; failSecond?: boolean; changeAccountAfterSigning?: boolean; sessionMs?: number } = {}) {
  const calls: Array<{ did: string; entries: PermissionEntry[]; options: { expiry: number; disableSubDelegation?: boolean } }> = [];
  const revoked: string[] = [];
  let account = OWNER;
  const sessionStore = { getToken: () => "token", getAddress: () => account };
  const tcw = {
    session: () => ({ siwe: siweEndingIn(options.sessionMs ?? 30 * DAY), signature: "sig" }),
    hasPermissions: () => options.allowed ?? true,
    hosts: ["https://node.example"],
    delegateTo: async (did: string, entries: PermissionEntry[], opts: { expiry: number; disableSubDelegation?: boolean }) => {
      calls.push({ did, entries, options: opts });
      if (options.prompted) return { prompted: true };
      if (options.failSecond && calls.length === 2) throw new Error("second_failed");
      if (options.changeAccountAfterSigning && calls.length === 2) account = "0x2222222222222222222222222222222222222222";
      return { prompted: false, delegation: { cid: `bafy-${calls.length}`, delegationHeader: { Authorization: "Bearer jwt" }, expiry: new Date() } };
    },
    revokeDelegation: async (cid: string) => {
      revoked.push(cid);
      return { ok: true };
    },
  } as unknown as TinyCloudWeb;
  return { tcw, sessionStore, calls, revoked };
}

describe("signing the pair", () => {
  test("two terminal grants to the delegate, no longer than a week, signed under the sign-in message", async () => {
    const s = signingSetup();
    const grants = await signFirefliesImportGrants(s.tcw, s.sessionStore, DELEGATE);

    expect(s.calls).toHaveLength(2);
    for (const call of s.calls) {
      expect(call.did).toBe(DELEGATE);
      expect(call.options.disableSubDelegation).toBe(true);
      expect(call.options.expiry).toBeLessThanOrEqual(7 * DAY - 60_000);
    }
    expect(s.calls[0]!.entries).toEqual(firefliesSecretsGrantEntries(OWNER));
    expect(s.calls[1]!.entries).toEqual(firefliesMeetingsGrantEntries());
    expect(grants.signature).toBe("sig");
    expect(grants.siwe).toContain("Expiration Time");
    expect(firefliesGrantCids(grants)).toEqual(["bafy-1", "bafy-2"]);
  });

  test("a grant never outlasts the sign-in that signs it", async () => {
    const s = signingSetup({ sessionMs: 2 * DAY });
    await signFirefliesImportGrants(s.tcw, s.sessionStore, DELEGATE);
    expect(s.calls[0]!.options.expiry).toBeLessThanOrEqual(2 * DAY);
  });

  test("missing authority, an approval prompt, a bad delegate and an ended sign-in all refuse without signing", async () => {
    const noAuthority = signingSetup({ allowed: false });
    await expect(signFirefliesImportGrants(noAuthority.tcw, noAuthority.sessionStore, DELEGATE)).rejects.toMatchObject({ code: "authority_missing" });
    expect(noAuthority.calls).toHaveLength(0);
    const noKey = signingSetup();
    await expect(signFirefliesImportGrants(noKey.tcw, noKey.sessionStore, "did:pkh:eip155:1:0xabc")).rejects.toMatchObject({ code: "signer_invalid" });
    expect(noKey.calls).toHaveLength(0);
    const ended = signingSetup({ sessionMs: 30_000 });
    await expect(signFirefliesImportGrants(ended.tcw, ended.sessionStore, DELEGATE)).rejects.toMatchObject({ code: "session_expired" });
    expect(ended.calls).toHaveLength(0);
    const prompted = signingSetup({ prompted: true });
    await expect(signFirefliesImportGrants(prompted.tcw, prompted.sessionStore, DELEGATE)).rejects.toMatchObject({ code: "unexpected_approval" });
  });

  test("when the second grant fails the first is withdrawn; when the account changes both are", async () => {
    const failed = signingSetup({ failSecond: true });
    await expect(signFirefliesImportGrants(failed.tcw, failed.sessionStore, DELEGATE)).rejects.toThrow("second_failed");
    expect(failed.revoked).toEqual(["bafy-1"]);

    const changed = signingSetup({ changeAccountAfterSigning: true });
    await expect(signFirefliesImportGrants(changed.tcw, changed.sessionStore, DELEGATE)).rejects.toBeInstanceOf(FirefliesImportSignError);
    expect(changed.revoked).toEqual(["bafy-1", "bafy-2"]);
  });
});

const STATUS: FirefliesImportStatus = { state: "none", expiresAt: null, delegateDid: DELEGATE, grantCids: [] };
const PAIR: FirefliesImportGrants = {
  secretsGrant: JSON.stringify({ cid: "new-secrets" }),
  meetingsGrant: JSON.stringify({ cid: "new-meetings" }),
  siwe: "siwe",
  signature: "sig",
};

function fakeDeps(options: {
  status?: Array<ConnectorWebhooksResult<FirefliesImportStatus>>;
  submit?: () => ConnectorWebhooksResult<{ state: "active"; expiresAt: string }>;
  sign?: () => Promise<FirefliesImportGrants>;
  revoke?: (cid: string) => boolean;
  remove?: () => ConnectorWebhooksResult<null>;
} = {}) {
  const log: string[] = [];
  const sent: string[][] = [];
  const statuses = [...(options.status ?? [{ status: "ok" as const, value: STATUS }])];
  const api: FirefliesImportApi = {
    status: async () => {
      log.push("status");
      return statuses.length > 1 ? statuses.shift()! : statuses[0]!;
    },
    submit: async (_grants, replaces) => {
      log.push("submit");
      sent.push([...replaces]);
      return options.submit ? options.submit() : { status: "ok", value: { state: "active", expiresAt: "2026-11-29T17:00:00.000Z" } };
    },
    removeGrant: async () => {
      log.push("remove");
      return options.remove ? options.remove() : { status: "ok", value: null };
    },
  };
  return {
    log,
    sent,
    deps: {
      api,
      sign: options.sign ?? (async () => PAIR),
      revoke: async (cid: string) => {
        log.push(`revoke:${cid}`);
        return options.revoke ? options.revoke(cid) : true;
      },
    },
  };
}

describe("turning on and replacing the pair", () => {
  test("signs for the delegate the server named, hands the pair over, then withdraws the pair it replaces", async () => {
    const t = fakeDeps({ status: [{ status: "ok", value: { ...STATUS, state: "active", expiresAt: "2026-11-23T00:00:00.000Z", grantCids: ["old-1", "old-2"] } }] });
    const outcome = await turnOnFirefliesImport(t.deps);

    expect(outcome).toEqual({ kind: "on", expiresAt: "2026-11-29T17:00:00.000Z", oldGrantsUnconfirmed: false });
    expect(t.log).toEqual(["status", "submit", "revoke:old-1", "revoke:old-2"]);
  });

  test("a refused pair is withdrawn and nothing else is touched", async () => {
    const t = fakeDeps({ submit: () => ({ status: "rejected", httpStatus: 400, code: null }) });
    expect(await turnOnFirefliesImport(t.deps)).toEqual({ kind: "failed" });
    expect(t.log).toEqual(["status", "submit", "revoke:new-secrets", "revoke:new-meetings"]);
  });

  test("a lost answer is asked about, and the new pair is withdrawn only when the server does not hold it", async () => {
    const saved: FirefliesImportStatus = { ...STATUS, state: "active", expiresAt: "2026-11-29T17:00:00.000Z", grantCids: ["new-secrets", "new-meetings"] };
    const t = fakeDeps({
      status: [{ status: "ok", value: STATUS }, { status: "ok", value: saved }],
      submit: () => ({ status: "offline" }),
    });
    expect(await turnOnFirefliesImport(t.deps)).toEqual({ kind: "on", expiresAt: "2026-11-29T17:00:00.000Z", oldGrantsUnconfirmed: false });
    expect(t.log).toEqual(["status", "submit", "status"]);

    // The server does not list the new pair: nothing records it, so it is withdrawn.
    const notHeld = fakeDeps({ submit: () => ({ status: "retryable", httpStatus: 503, code: null }) });
    expect(await turnOnFirefliesImport(notHeld.deps)).toEqual({ kind: "unavailable" });
    expect(notHeld.log).toEqual(["status", "submit", "status", "revoke:new-secrets", "revoke:new-meetings"]);

    // The server cannot be asked: the pair may be held, so it is left alone.
    const unreadable = fakeDeps({
      status: [{ status: "ok", value: STATUS }, { status: "offline" }],
      submit: () => ({ status: "offline" }),
    });
    expect(await turnOnFirefliesImport(unreadable.deps)).toEqual({ kind: "unavailable" });
    expect(unreadable.log.some((entry) => entry.startsWith("revoke:"))).toBe(false);
  });

  test("a saved pair behind a lost answer still has the pair it replaced withdrawn", async () => {
    const held: FirefliesImportStatus = { ...STATUS, state: "active", expiresAt: "2026-11-23T00:00:00.000Z", grantCids: ["old-1", "old-2"] };
    const saved: FirefliesImportStatus = { ...held, expiresAt: "2026-11-29T17:00:00.000Z", grantCids: ["new-secrets", "new-meetings"] };
    const t = fakeDeps({
      status: [{ status: "ok", value: held }, { status: "ok", value: saved }],
      submit: () => ({ status: "offline" }),
    });
    expect(await turnOnFirefliesImport(t.deps)).toEqual({ kind: "on", expiresAt: "2026-11-29T17:00:00.000Z", oldGrantsUnconfirmed: false });
    expect(t.log).toEqual(["status", "submit", "status", "revoke:old-1", "revoke:old-2"]);
  });

  test("the pair names the ids it replaces, and a refusal for a mismatch withdraws the new pair", async () => {
    const held: FirefliesImportStatus = { ...STATUS, state: "active", expiresAt: "2026-11-23T00:00:00.000Z", grantCids: ["old-1", "old-2"] };
    const t = fakeDeps({ status: [{ status: "ok", value: held }], submit: () => ({ status: "rejected", httpStatus: 409, code: null }) });
    expect(await turnOnFirefliesImport(t.deps)).toEqual({ kind: "failed" });
    expect(t.sent).toEqual([["old-1", "old-2"]]);
    expect(t.log).toEqual(["status", "submit", "revoke:new-secrets", "revoke:new-meetings"]);

    const first = fakeDeps();
    await turnOnFirefliesImport(first.deps);
    expect(first.sent).toEqual([[]]);
  });

  test("an old pair that cannot be withdrawn is reported, and the new pair still stands", async () => {
    const t = fakeDeps({ revoke: () => false });
    const outcome = await replaceFirefliesImportGrants(t.deps, { ...STATUS, state: "active", expiresAt: null, grantCids: ["old-1"] });
    expect(outcome).toMatchObject({ kind: "on", oldGrantsUnconfirmed: true });
  });

  test("a session that cannot sign asks the owner to sign in and sends nothing", async () => {
    const t = fakeDeps({ sign: async () => { throw new FirefliesImportSignError("authority_missing"); } });
    expect(await turnOnFirefliesImport(t.deps)).toEqual({ kind: "needs-sign-in" });
    expect(t.log).toEqual(["status"]);
  });
});

describe("turning off", () => {
  function grants(log: string[], revoke: (cid: string) => boolean = () => true) {
    return {
      listGrantCids: async () => {
        log.push("list");
        return { status: "ok" as const, value: ["a", "b"] };
      },
      revoke: async (cid: string) => {
        log.push(`revoke:${cid}`);
        return revoke(cid);
      },
    };
  }

  test("reads the ids, makes the server drop its copy, then withdraws both", async () => {
    const t = fakeDeps();
    expect(await turnOffFirefliesImport(t.deps.api, grants(t.log))).toEqual({ kind: "off" });
    expect(t.log).toEqual(["list", "remove", "revoke:a", "revoke:b"]);
  });

  test("a permission that is not confirmed withdrawn is disclosed; a server that cannot be reached changes nothing", async () => {
    const t = fakeDeps();
    expect(await turnOffFirefliesImport(t.deps.api, grants(t.log, (cid) => cid !== "b"))).toEqual({ kind: "off-unconfirmed" });

    const down = fakeDeps({ remove: () => ({ status: "retryable", httpStatus: 503, code: null }) });
    expect(await turnOffFirefliesImport(down.deps.api, grants(down.log))).toEqual({ kind: "unavailable" });
    expect(down.log).toEqual(["list", "remove"]);
  });
});

describe("when the silent tick replaces the pair", () => {
  const siwe = (ms: number) => `Expiration Time: ${new Date(NOW + ms).toISOString()}`;
  const active = (leftMs: number): FirefliesImportStatus => ({ ...STATUS, state: "active", expiresAt: new Date(NOW + leftMs).toISOString(), grantCids: ["a", "b"] });

  test("an active pair with under 6 days left, only when the sign-in can extend it", () => {
    expect(firefliesImportDue(active(5 * DAY), { siwe: siwe(30 * DAY), wanted: true, now: NOW })).toBe(true);
    expect(firefliesImportDue(active(6.5 * DAY), { siwe: siwe(30 * DAY), wanted: true, now: NOW })).toBe(false);
    // The sign-in ends with the pair: a replacement would end no later.
    expect(firefliesImportDue(active(5 * DAY), { siwe: siwe(5 * DAY), wanted: true, now: NOW })).toBe(false);
    expect(sessionCanExtend(siwe(30_000), null, NOW)).toBe(false);
  });

  test("only on the browser where the owner turned the import on, whatever the pair's state", () => {
    expect(firefliesImportDue(active(5 * DAY), { siwe: siwe(30 * DAY), wanted: false, now: NOW })).toBe(false);
    const lapsed: FirefliesImportStatus = { ...STATUS, state: "needs_renewal", expiresAt: new Date(NOW - DAY).toISOString(), grantCids: ["a", "b"] };
    expect(firefliesImportDue(lapsed, { siwe: siwe(30 * DAY), wanted: true, now: NOW })).toBe(true);
    expect(firefliesImportDue(lapsed, { siwe: siwe(30 * DAY), wanted: false, now: NOW })).toBe(false);
  });

  test("never a revoked pair, nothing stored, or a status that lists no ids to replace", () => {
    const lapsed: FirefliesImportStatus = { ...STATUS, state: "needs_renewal", expiresAt: new Date(NOW - DAY).toISOString(), grantCids: ["a", "b"] };
    expect(firefliesImportDue({ ...lapsed, state: "revoked" }, { siwe: siwe(30 * DAY), wanted: true, now: NOW })).toBe(false);
    expect(firefliesImportDue(STATUS, { siwe: siwe(30 * DAY), wanted: true, now: NOW })).toBe(false);
    // Active with no ids is what a status read torn by a removal looks like: it must not be written back.
    expect(firefliesImportDue({ ...active(5 * DAY), grantCids: [] }, { siwe: siwe(30 * DAY), wanted: true, now: NOW })).toBe(false);
    expect(firefliesImportDue({ ...lapsed, grantCids: [] }, { siwe: siwe(30 * DAY), wanted: true, now: NOW })).toBe(false);
  });

  test("a due pair is replaced once; a pair that is not due, or not wanted here, is left alone", async () => {
    const dueStatus = { ...active(5 * DAY), expiresAt: new Date(Date.now() + 5 * DAY).toISOString() };
    const due = fakeDeps({ status: [{ status: "ok", value: dueStatus }] });
    const longSiwe = `Expiration Time: ${new Date(Date.now() + 30 * DAY).toISOString()}`;
    expect(await renewFirefliesImportIfDue(due.deps, { siwe: longSiwe, wanted: true })).toBe(true);
    expect(due.log).toEqual(["status", "submit", "revoke:a", "revoke:b"]);
    expect(due.sent).toEqual([["a", "b"]]);

    const fresh = fakeDeps({ status: [{ status: "ok", value: { ...active(7 * DAY), expiresAt: new Date(Date.now() + 7 * DAY).toISOString() } }] });
    expect(await renewFirefliesImportIfDue(fresh.deps, { siwe: longSiwe, wanted: true })).toBe(false);
    expect(fresh.log).toEqual(["status"]);

    const elsewhere = fakeDeps({ status: [{ status: "ok", value: dueStatus }] });
    expect(await renewFirefliesImportIfDue(elsewhere.deps, { siwe: longSiwe, wanted: false })).toBe(false);
    expect(elsewhere.log).toEqual(["status"]);
  });

  test("a renewal that read the status before a turn off or purge is refused and leaves nothing behind", async () => {
    const dueStatus = { ...active(5 * DAY), expiresAt: new Date(Date.now() + 5 * DAY).toISOString() };
    const t = fakeDeps({ status: [{ status: "ok", value: dueStatus }], submit: () => ({ status: "rejected", httpStatus: 409, code: null }) });
    const longSiwe = `Expiration Time: ${new Date(Date.now() + 30 * DAY).toISOString()}`;
    expect(await renewFirefliesImportIfDue(t.deps, { siwe: longSiwe, wanted: true })).toBe(false);
    // The new pair is withdrawn; the old one is not touched, the owner's own removal handles it.
    expect(t.log).toEqual(["status", "submit", "revoke:new-secrets", "revoke:new-meetings"]);
  });

  test("the row says on, ending soon, paused or off from what the server holds", () => {
    expect(firefliesImportPhase(active(3 * DAY), NOW)).toBe("on");
    expect(firefliesImportPhase(active(3_600_000), NOW)).toBe("ending-soon");
    expect(firefliesImportPhase(active(-1000), NOW)).toBe("paused");
    expect(firefliesImportPhase({ ...STATUS, state: "needs_renewal" }, NOW)).toBe("paused");
    expect(firefliesImportPhase(STATUS, NOW)).toBe("off");
  });

  test("the turned-on mark is kept per account", () => {
    const map = new Map<string, string>();
    const store = { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v), removeItem: (k: string) => void map.delete(k) };
    writeFirefliesImportWanted(OWNER, true, store);
    expect(readFirefliesImportWanted(OWNER.toUpperCase().replace("0X", "0x"), store)).toBe(true);
    expect(readFirefliesImportWanted("0x2222222222222222222222222222222222222222", store)).toBe(false);
    writeFirefliesImportWanted(OWNER, false, store);
    expect(readFirefliesImportWanted(OWNER, store)).toBe(false);
  });
});
