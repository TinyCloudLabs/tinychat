// A monitoring check for the Home mirror (TC-2204): post one fixed test ask through the mirror, read the Home card,
// its binding and the board copy back, then remove all three. It runs only in a QA owner space, never the owner's
// production space, and exits with the mirror's codes: 0 passed, 2 bad input, 6 transient, 1 anything else.
import { parseArgs } from "node:util";
import { createHash } from "node:crypto";
import { ErrorCodes } from "@tinycloud/sdk-services";
import { listFeedCards } from "@tinycloud/sdk-services/feed";
import { boardKey, validateRecord } from "@tinyboilerplate/core/feed/sitrep";
import type { BoardRecord } from "@tinyboilerplate/core/feed/sitrep";
import { homeMirrorDiagnostic, homeMirrorRefusal, publishHomeMirror, readHomeMirrorBinding, readHomeMirrorSource } from "./bridge";
import type { HomeMirrorContext } from "./bridge-types";
import { boardCard, boardCardIdentity } from "./inventory";
import { openOwnerSession, withStopSignal } from "./owner-session";
import type { OwnerSession } from "./owner-session";

/** The production owner's account: the check refuses any space of it. */
const PRODUCTION_OWNER = "0xd559ccd9eb87c530a9a349262669386de93cf412";
export const SYNTHETIC_ID = "home-mirror-synthetic-check";
const FIXED_AT = "2026-11-13T00:00:00.000Z";

export function syntheticRecord(): BoardRecord {
  const checked = validateRecord("ask", {
    kind: "ask", id: SYNTHETIC_ID, from: "Monitoring", owner: "Monitoring", title: "Home mirror check", body: "A test card the mirror check posts and removes.",
    createdAt: FIXED_AT, updatedAt: FIXED_AT, askedAt: FIXED_AT, links: [], urgency: 0, importance: 0, status: "open",
    options: [{ id: "ok", label: "OK" }],
    context: { background: "The Home mirror check posts this card and removes it within the same run.", whyNow: "It checks that cards reach Home.", ifNoAnswer: "Nothing: the check removes the card.", known: [], related: [] },
  });
  if (!checked.ok) throw homeMirrorRefusal("Home mirror operation refused");
  return checked.value;
}

export interface SyntheticResult { ok: true; cardId: string; postMs: number; readbackMs: number; cleanupMs: number }

type Cleanup = Pick<OwnerSession["legacyKv"], "get" | "delete">;

async function removeAll(ctx: HomeMirrorContext, legacyKv: Cleanup, output: string, sourceId: string, identity: ReturnType<typeof boardCardIdentity>, key: string): Promise<void> {
  const take = <T>(result: { ok: true; data: T } | { ok: false; error: unknown }): T => { if (!result.ok) throw result.error; return result.data; };
  take(await ctx.sql.db(output).execute("DELETE FROM feed_cards WHERE card_id=? AND revision=? AND issuance_id=?", [identity.cardId, identity.revision, identity.issuanceId], { signal: ctx.signal, redactErrors: true }));
  take(await ctx.sql.db("xyz.tinycloud.tinychat/home_feed").execute("DELETE FROM feed_sitrep_mirrors WHERE source_id=? AND card_id=? AND revision=? AND issuance_id=?", [sourceId, identity.cardId, identity.revision, identity.issuanceId], { signal: ctx.signal, redactErrors: true }));
  const head = await legacyKv.get(key, { binary: true, source: "network", prefix: "", signal: ctx.signal });
  if (head.ok) take(await legacyKv.delete(key, { prefix: "", ifMatch: head.data.headers.etag, signal: ctx.signal }));
  else if (head.error.code !== ErrorCodes.KV_NOT_FOUND) throw head.error;
}

export async function runSyntheticCheck(ctx: HomeMirrorContext, legacyKv: Cleanup, options: { sourceId: string }): Promise<SyntheticResult> {
  if ([ctx.ownerSpaceId, ctx.legacySpaceId].some((space) => space.toLowerCase().includes(PRODUCTION_OWNER))) throw homeMirrorRefusal("The synthetic check runs only in a QA owner space");
  const record = syntheticRecord(), key = boardKey("ask", SYNTHETIC_ID), identity = boardCardIdentity(key);
  const source = await readHomeMirrorSource(ctx, options.sourceId);
  // A run that stopped before its cleanup left these behind; this identity is the check's alone.
  await removeAll(ctx, legacyKv, source.output.database, options.sourceId, identity, key);
  const card = boardCard({ key, record }, [record], Date.parse(FIXED_AT));
  let started = Date.now(), postMs: number, readbackMs: number, cleanupMs: number;
  try {
    const binding = await publishHomeMirror(ctx, { source: { ...source, label: "Monitoring" }, card, legacy: { spaceId: ctx.legacySpaceId, fullKey: key, record } });
    postMs = Date.now() - started; started = Date.now();
    const cards = await listFeedCards(ctx.sql.db(source.output.database));
    const stored = cards.ok ? cards.data.find((item) => item.cardId === identity.cardId && item.revision === identity.revision && item.issuanceId === identity.issuanceId) : undefined;
    const bound = await readHomeMirrorBinding(ctx, { sourceId: options.sourceId, ...identity });
    const copy = await legacyKv.get<Uint8Array>(key, { binary: true, source: "network", prefix: "", signal: ctx.signal });
    const bytes = copy.ok && copy.data.data instanceof Uint8Array ? copy.data.data : undefined;
    const sha = bytes ? createHash("sha256").update(bytes).digest("hex") : undefined;
    const uuid = bytes ? (JSON.parse(new TextDecoder().decode(bytes)) as { cardUuid?: unknown }).cardUuid : undefined;
    readbackMs = Date.now() - started;
    if (!stored || stored.title !== card.title || !bound || bound.legacy.publicationSha256 !== binding.legacy.publicationSha256 || sha !== binding.legacy.publicationSha256 || uuid !== identity.cardId) {
      throw homeMirrorRefusal("Synthetic check readback did not match", "HOME_MIRROR_ERROR");
    }
  } finally {
    started = Date.now();
    await removeAll(ctx, legacyKv, source.output.database, options.sourceId, identity, key);
    cleanupMs = Date.now() - started;
  }
  return { ok: true, cardId: identity.cardId, postMs: postMs!, readbackMs: readbackMs!, cleanupMs: cleanupMs! };
}

export async function runSyntheticCheckCli(argv: string[]): Promise<number> {
  try {
    const { values } = parseArgs({ args: argv, strict: true, options: {
      "tc-home": { type: "string" }, profile: { type: "string" }, host: { type: "string" },
      "owner-space": { type: "string" }, "legacy-space": { type: "string" }, source: { type: "string" },
    } });
    if (!values["tc-home"] || !values.profile || !values["owner-space"] || !values["legacy-space"] || !values.source) throw homeMirrorRefusal("Synthetic check requires a profile, full spaces and a source");
    const ownerSpace = values["owner-space"], legacySpace = values["legacy-space"];
    if ([ownerSpace, legacySpace].some((space) => space.toLowerCase().includes(PRODUCTION_OWNER))) throw homeMirrorRefusal("The synthetic check runs only in a QA owner space");
    const result = await withStopSignal(async (signal) => {
      const { ctx, legacyKv } = await openOwnerSession({ tcHome: values["tc-home"]!, profile: values.profile!, ownerSpace, legacySpace, host: values.host, signal });
      return runSyntheticCheck(ctx, legacyKv, { sourceId: values.source! });
    });
    process.stdout.write(`${JSON.stringify({ operation: "synthetic-check", result })}\n`);
    return 0;
  } catch (error) {
    const diagnostic = homeMirrorDiagnostic(error);
    process.stderr.write(`${JSON.stringify(diagnostic)}\n`);
    return diagnostic.exitCode;
  }
}

if (import.meta.main) process.exitCode = await runSyntheticCheckCli(process.argv.slice(2));
