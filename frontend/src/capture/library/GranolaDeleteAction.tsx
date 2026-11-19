import { useEffect, useMemo, useRef, useState } from "react";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { Loader2Icon, Trash2Icon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ResponsiveSheet, ResponsiveSheetBody } from "@/components/ui/responsive-sheet";
import { deleteGranolaCsvMeeting } from "@/lib/connectors/connectorStore";
import { runGranolaSpaceWrite } from "@/lib/connectors/granolaSync";
import { scheduledSpace } from "@/lib/spaceQueue";
import { captureEvents } from "../captureEvents";
import { accountCacheKey, deleteLocal } from "@/lib/localFirst/localCache";
import type { LibraryItem } from "./LibraryRow";

const DELETE_DESCRIPTION = "This deletes the meeting and its transcript from your Library. Combined meetings that use it are deleted too; other meetings stay. Copies already saved, shared or quoted elsewhere, such as in a chat, aren't removed. It won't come back in a Granola sync or CSV import unless you choose “Allow deleted meetings back”.";

export function GranolaDeleteAction({ tcw, item, onChanged, onDeleted }: {
  tcw: TinyCloudWeb;
  item: LibraryItem;
  onChanged: () => void;
  onDeleted: () => void;
}) {
  const scope = useMemo(() => ({
    space: scheduledSpace(tcw), sourceId: item.sourceId, ownerDid: tcw.did ?? null, spaceId: tcw.spaceId ?? null,
  }), [tcw, tcw.did, tcw.spaceId, item.id, item.sourceId]);
  const current = useRef<typeof scope | null>(scope);
  current.current = scope;
  useEffect(() => {
    current.current = scope;
    return () => { if (current.current === scope) current.current = null; };
  }, [scope]);
  const inFlight = useRef<typeof scope | null>(null);
  const [confirmation, setConfirmation] = useState<{ scope: typeof scope; phase: "asking" | "busy" | "failed" } | null>(null);
  const open = confirmation?.scope === scope;
  const busy = confirmation?.scope === scope && confirmation.phase === "busy";
  const keep = () => { if (inFlight.current !== scope) setConfirmation(null); };
  const confirm = async () => {
    if (!open || inFlight.current === scope) return;
    inFlight.current = scope;
    setConfirmation({ scope, phase: "busy" });
    const deleted = await runGranolaSpaceWrite(async () => {
      if (current.current !== scope) return null;
      return deleteGranolaCsvMeeting(scope.space, scope.sourceId);
    }).then(result => result?.ok === true, () => false);
    if (inFlight.current === scope) inFlight.current = null;
    if (deleted) {
      if (scope.ownerDid) await deleteLocal(accountCacheKey(scope.ownerDid, "library"));
      captureEvents.emit("note-deleted", { source: "granola", sourceId: scope.sourceId, ownerDid: scope.ownerDid, spaceId: scope.spaceId });
    }
    if (current.current !== scope) return;
    if (!deleted) {
      setConfirmation({ scope, phase: "failed" });
      return;
    }
    setConfirmation(null);
    captureEvents.emit("library-changed", { source: "granola", sourceId: scope.sourceId });
    onChanged();
    onDeleted();
  };

  return (
    <>
      <Button type="button" variant="ghost" size="sm" onClick={() => setConfirmation({ scope, phase: "asking" })} disabled={busy}>
        <Trash2Icon aria-hidden /> Delete meeting
      </Button>
      <ResponsiveSheet
        open={open}
        onOpenChange={(next) => { if (!next) keep(); }}
        dismissible={!busy}
        title="Delete imported meeting?"
        description={DELETE_DESCRIPTION}
        contentProps={{ "data-testid": "delete-granola-sheet" }}
        footer={
          <>
            <Button type="button" variant="outline" onClick={keep} disabled={busy}>Keep meeting</Button>
            <Button type="button" variant="destructive" onClick={() => void confirm()} disabled={busy}>
              {busy && <Loader2Icon aria-hidden className="motion-safe:animate-spin" />} Delete meeting
            </Button>
          </>
        }
      >
        <ResponsiveSheetBody>
          {confirmation?.scope === scope && confirmation.phase === "failed" && (
            <p role="alert" className="text-callout text-destructive">Couldn't delete this meeting. Try again.</p>
          )}
        </ResponsiveSheetBody>
      </ResponsiveSheet>
    </>
  );
}
