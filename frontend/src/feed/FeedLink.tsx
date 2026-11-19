import type { AnchorHTMLAttributes } from "react";
import { lazyTab } from "@/shell/lazyTab";
import { closeLinkSheet, openLinkInApp, useLinkSheet, useLinkSheetHost } from "./inAppLink";

/**
 * A link in the Feed. Still a plain new-tab link (copy, long-press, cmd-click and middle click all work as before);
 * a plain tap or click on another site's page opens it inside the app instead (inAppLink.ts). `sheet={false}`: the
 * phone app's browser only; on the web it stays a new-tab link.
 */
export function FeedLink({ href, sheet = true, onClick, children, ...props }: Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "target" | "rel"> & { href: string; sheet?: boolean }) {
  return <a {...props} href={href} target="_blank" rel="noopener noreferrer" onClick={(event) => {
    onClick?.(event);
    openLinkInApp(href, event.nativeEvent, { sheet, opener: event.currentTarget });
  }}>{children}</a>;
}

/** The sheet and its frame, in a chunk of their own: loaded on the first link opened. */
const LazyLinkSheet = lazyTab("the page", () => import("./LinkSheet").then((module) => module.LinkSheet));

/** The Feed's one web sheet for links (mounted once per Feed). Without it, Feed links stay plain links. */
export function LinkSheetHost() {
  useLinkSheetHost();
  const { url, open, opener } = useLinkSheet();
  return url ? <LazyLinkSheet url={url} open={open} opener={opener} onOpenChange={(next) => { if (!next) closeLinkSheet(); }} /> : null;
}
