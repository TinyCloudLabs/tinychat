import { useCallback, useEffect, useState, type FC } from "react";
import { LinkIcon } from "lucide-react";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { SectionCard } from "@/components/ui/section-card";
import { SHARE_LINK_COPY } from "@/lib/shareLinkCopy";
import { isLocalThreadStorage } from "@/lib/threadStore";
import {
  listOwnedTinychatShares,
  shareStopFailureMessage,
  stopOwnedTinychatShare,
  type OwnedTinychatShare,
} from "@/lib/tinychatShareLinks";

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

/** The owner's existing share links, each with a Revoke that asks first. Never offers to create one. */
export const OwnedShareLinkList: FC<{
  shares: readonly OwnedTinychatShare[];
  revokingId: string | null;
  onRevoke: (shareId: string) => void;
}> = ({ shares, revokingId, onRevoke }) => {
  const [confirmId, setConfirmId] = useState<string | null>(null);
  return (
    <>
      <ul className="flex flex-col gap-2">
        {shares.map((item) => (
          <li key={item.shareId} className="flex items-center justify-between gap-3 text-sm">
            <span className="min-w-0 truncate">{item.title}</span>
            <span className="shrink-0 text-xs text-muted-foreground">
              Expires {formatShareDate(item.expiresAt)}
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={revokingId !== null}
              onClick={() => setConfirmId(item.shareId)}
            >
              {revokingId === item.shareId ? SHARE_LINK_COPY.revoking : SHARE_LINK_COPY.revoke}
            </Button>
          </li>
        ))}
      </ul>
      <Dialog open={confirmId !== null} onOpenChange={(next) => !next && setConfirmId(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{SHARE_LINK_COPY.confirmTitle}</DialogTitle>
            <DialogDescription>{SHARE_LINK_COPY.confirmBody}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setConfirmId(null)}>
              {SHARE_LINK_COPY.confirmCancel}
            </Button>
            <Button
              type="button"
              onClick={() => {
                const id = confirmId;
                setConfirmId(null);
                if (id) onRevoke(id);
              }}
            >
              {SHARE_LINK_COPY.confirmRevoke}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
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

/** Loads the owner's links. A failed load only sets `loadFailed`; the error text is never kept. */
export function useOwnedShares(tcw: TinyCloudWeb) {
  const [shares, setShares] = useState<OwnedTinychatShare[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const refresh = useCallback(async () => {
    try {
      setShares(await listOwnedTinychatShares(tcw));
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
    }
  }, [tcw]);
  return { shares, loadFailed, refresh };
}

/** Settings entry to the same list, so links stay reachable without a chat that has a local copy. */
export const OwnedShareLinksCard: FC<{ tcw: TinyCloudWeb }> = ({ tcw }) => {
  const { shares, loadFailed, refresh } = useOwnedShares(tcw);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const local = isLocalThreadStorage(tcw);

  useEffect(() => {
    if (!local) void refresh();
  }, [local, refresh]);

  const revoke = async (shareId: string) => {
    setRevokingId(shareId);
    setError(null);
    try {
      const stopped = await stopOwnedTinychatShare(tcw, shareId);
      if (!stopped.ok) setError(shareStopFailureMessage(stopped.stage));
      else await refresh();
    } finally {
      setRevokingId(null);
    }
  };

  if (local) return null;
  return (
    <SectionCard icon={LinkIcon} title={SHARE_LINK_COPY.listTitle}>
      <p className="text-xs text-muted-foreground">{SHARE_LINK_COPY.listDescription}</p>
      {error && (
        <div className="mt-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}
      <div className="mt-3">
        {loadFailed ? (
          <ShareLinksLoadFailed onRetry={() => void refresh()} />
        ) : shares?.length ? (
          <OwnedShareLinkList shares={shares} revokingId={revokingId} onRevoke={(id) => void revoke(id)} />
        ) : shares ? (
          <p className="text-sm text-muted-foreground">{SHARE_LINK_COPY.listEmpty}</p>
        ) : null}
      </div>
    </SectionCard>
  );
};
