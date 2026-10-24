import { useCallback, useEffect, useState, type FC } from "react";
import { LinkIcon } from "lucide-react";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { Button } from "@/components/ui/button";
import { SectionCard } from "@/components/ui/section-card";
import { formatShareExpiry, unexpiredShares } from "@/lib/shareExpiry";
import { SHARE_LINK_COPY } from "@/lib/shareLinkCopy";
import { isLocalThreadStorage } from "@/lib/threadStore";
import { listOwnedTinychatShares, type OwnedTinychatShare } from "@/lib/tinychatShareLinks";

export function formatShareDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** The owner's existing share links with their expiry. Read-only: it never offers to create or revoke one. */
export const OwnedShareLinkList: FC<{ shares: readonly OwnedTinychatShare[] }> = ({ shares }) => {
  const now = Date.now();
  return (
    <ul className="flex flex-col gap-2">
      {shares.map((item) => (
        <li key={item.shareId} className="flex items-center justify-between gap-3 text-sm">
          <span className="min-w-0 truncate">{item.title}</span>
          <span className="shrink-0 text-xs text-muted-foreground">{formatShareExpiry(item.expiresAt, now)}</span>
        </li>
      ))}
    </ul>
  );
};

/** Shown instead of a list when the owner's links could not be loaded. Never carries the error text. */
export const ShareLinksLoadFailed: FC<{ onRetry: () => void }> = ({ onRetry }) => (
  <div className="flex items-center justify-between gap-3 text-sm">
    <span className="min-w-0 text-muted-foreground">{SHARE_LINK_COPY.loadFailed}</span>
    <Button type="button" variant="outline" size="sm" onClick={onRetry}>
      {SHARE_LINK_COPY.retry}
    </Button>
  </div>
);

/**
 * Loads the owner's links, hiding any that have expired. A failed load only sets `loadFailed`;
 * the error text is never kept.
 */
export function useOwnedShares(tcw: TinyCloudWeb) {
  const [loaded, setLoaded] = useState<OwnedTinychatShare[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const refresh = useCallback(async () => {
    try {
      setLoaded(await listOwnedTinychatShares(tcw));
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
    }
  }, [tcw]);
  const shares = loaded && unexpiredShares(loaded, Date.now());
  return { shares, loadFailed, refresh };
}

/** Settings entry to the same list, so links stay reachable without a chat that has a local copy. */
export const OwnedShareLinksCard: FC<{ tcw: TinyCloudWeb }> = ({ tcw }) => {
  const { shares, loadFailed, refresh } = useOwnedShares(tcw);
  const local = isLocalThreadStorage(tcw);

  useEffect(() => {
    if (!local) void refresh();
  }, [local, refresh]);

  if (local) return null;
  return (
    <SectionCard icon={LinkIcon} title={SHARE_LINK_COPY.listTitle}>
      <p className="text-xs text-muted-foreground">{SHARE_LINK_COPY.listDescription}</p>
      <div className="mt-3">
        {loadFailed ? (
          <ShareLinksLoadFailed onRetry={() => void refresh()} />
        ) : shares?.length ? (
          <OwnedShareLinkList shares={shares} />
        ) : shares ? (
          <p className="text-sm text-muted-foreground">{SHARE_LINK_COPY.listEmpty}</p>
        ) : null}
      </div>
    </SectionCard>
  );
};
