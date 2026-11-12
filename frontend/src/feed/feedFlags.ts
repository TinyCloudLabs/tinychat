// The Home feed's design switches (TC-2600): three choices where Hunter's bridge-feed design differs from the
// approved feed, and one of his proposed rules, each off by default so the feed stays as approved.
//
//   layout   "list" (default): every card in one list, each opening in place.
//            "open-card": one raised open card, the others as one-line rows under it.
//   nav      "segments" (default): Needs you / All / History, with "Earlier" under All.
//            "agents": a view menu, then Agents and Filter; the list reads "Needs you · N" and "Updates · N".
//   undo     5 (default) or 4 seconds before an answer is sent.
//   captions "shown" (default): the line under the comment composer explains it.
//            "hidden": no line under it (Hunter's D8), and the control reads "Leave a comment for <agent>".
//
// A build sets a default with VITE_FEED_LAYOUT, VITE_FEED_NAV, VITE_FEED_UNDO and VITE_FEED_CAPTIONS. On a
// preview deployment or a local server, the address can switch them too (?feed.layout=open-card, ?feed=default
// to reset); the choice is kept in this browser. Any switch away from its default shows a marker on the feed.
import { createContext, useContext } from "react";

export type FeedLayout = "list" | "open-card";
export type FeedNav = "segments" | "agents";
export type FeedCaptions = "shown" | "hidden";
export interface FeedFlags { layout: FeedLayout; nav: FeedNav; undoSeconds: 4 | 5; captions: FeedCaptions }

export const DEFAULT_FEED_FLAGS: FeedFlags = { layout: "list", nav: "segments", undoSeconds: 5, captions: "shown" };
export const FEED_FLAGS_STORAGE_KEY = "tinychat.feed.flags.v1";

type Values = Partial<Record<"layout" | "nav" | "undo" | "captions", string | null | undefined>>;

/** Each recognised value; anything else leaves the flag as it was. */
function apply(flags: FeedFlags, values: Values): FeedFlags {
  return {
    layout: values.layout === "list" || values.layout === "open-card" ? values.layout : flags.layout,
    nav: values.nav === "segments" || values.nav === "agents" ? values.nav : flags.nav,
    undoSeconds: values.undo === "4" ? 4 : values.undo === "5" ? 5 : flags.undoSeconds,
    captions: values.captions === "shown" || values.captions === "hidden" ? values.captions : flags.captions,
  };
}

/**
 * Where the address may switch the feed: a local server, or a Cloudflare Pages preview
 * (<deployment or branch>.<project>.pages.dev). Never the production site, nor the project's bare
 * <project>.pages.dev, which serves production too.
 */
export function previewHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || /^[a-z0-9-]+\.[a-z0-9-]+\.pages\.dev$/i.test(hostname);
}

export interface FeedFlagInputs {
  env: Values;
  hostname: string;
  search: string;
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;
}

/**
 * The build's defaults, then, on a preview host only, the browser's saved switches and the address's.
 * A switch in the address is saved, so it survives a reload or a sign-in redirect; ?feed=default clears it.
 */
export function resolveFeedFlags({ env, hostname, search, storage }: FeedFlagInputs): FeedFlags {
  const built = apply(DEFAULT_FEED_FLAGS, env);
  if (!previewHost(hostname)) return built;
  const params = new URLSearchParams(search);
  if (params.get("feed") === "default") {
    try { storage?.removeItem(FEED_FLAGS_STORAGE_KEY); } catch { /* storage refused: nothing was saved */ }
    return built;
  }
  let saved: Values = {};
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(FEED_FLAGS_STORAGE_KEY) ?? "{}");
    if (parsed && typeof parsed === "object") saved = parsed as Values;
  } catch { /* unreadable: ignore it */ }
  const asked: Values = { layout: params.get("feed.layout"), nav: params.get("feed.nav"), undo: params.get("feed.undo"), captions: params.get("feed.captions") };
  const flags = apply(apply(built, saved), asked);
  if (Object.values(asked).some((value) => value !== null)) {
    const kept = { layout: flags.layout, nav: flags.nav, undo: String(flags.undoSeconds), captions: flags.captions };
    try { storage?.setItem(FEED_FLAGS_STORAGE_KEY, JSON.stringify(kept)); } catch { /* not kept past this page */ }
  }
  return flags;
}

let current: FeedFlags | undefined;
/** This page's switches, read once. */
export function feedFlags(): FeedFlags {
  if (current) return current;
  let storage: Storage | null;
  try { storage = globalThis.localStorage ?? null; } catch { storage = null; }
  current = resolveFeedFlags({
    env: { layout: import.meta.env.VITE_FEED_LAYOUT, nav: import.meta.env.VITE_FEED_NAV, undo: import.meta.env.VITE_FEED_UNDO, captions: import.meta.env.VITE_FEED_CAPTIONS },
    hostname: globalThis.location?.hostname ?? "",
    search: globalThis.location?.search ?? "",
    storage,
  });
  return current;
}

/** Tests and harness screens set the switches here; the app reads feedFlags(). */
export const FeedFlagsContext = createContext<FeedFlags | null>(null);
export function useFeedFlags(): FeedFlags {
  return useContext(FeedFlagsContext) ?? feedFlags();
}

/** The switches away from their defaults, in words, for the feed's marker; empty when all are default. */
export function changedFlags(flags: FeedFlags): string[] {
  return [
    ...(flags.layout !== DEFAULT_FEED_FLAGS.layout ? ["open card"] : []),
    ...(flags.nav !== DEFAULT_FEED_FLAGS.nav ? ["agents menu"] : []),
    ...(flags.undoSeconds !== DEFAULT_FEED_FLAGS.undoSeconds ? [`${flags.undoSeconds} s undo`] : []),
    ...(flags.captions !== DEFAULT_FEED_FLAGS.captions ? ["no captions"] : []),
  ];
}
