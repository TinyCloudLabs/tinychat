import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { RegistryPublishClient } from "@/lib/registryConsent/adapter";
import { FINISH_SETUP_NOTICE_COPY } from "@/lib/registryConsent/copy";
import { publishRegistryRecord, runFinishSetupIntent, type RegistryPublishEnv } from "@/lib/registryConsent/intent";

/**
 * What a finish-setup link says before anything is signed (TC-3547). A link opened without the Home card shows this
 * first; Publish asks the SDK and Cancel (the button, Escape or a tap outside) closes it with no SDK call and nothing
 * written. The words are the card's, from lib/registryConsent/copy.ts.
 */
export function FinishSetupNotice({ open, onPublish, onCancel }: { open: boolean; onPublish: () => void; onCancel: () => void }) {
  const copy = FINISH_SETUP_NOTICE_COPY;
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onCancel(); }}>
      <DialogContent hideCloseButton data-testid="finish-setup-notice">
        <DialogHeader>
          <DialogTitle>{copy.title}</DialogTitle>
          <DialogDescription>{copy.body}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onCancel}>{copy.cancel}</Button>
          <Button type="button" onClick={onPublish}>{copy.publish}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Handles a signed-in page opened (or navigated, by the Home card) to `?finish-setup=registry`: the query is removed
 * first. From the card the SDK is asked to publish at once; from a pasted or shared link the notice shows and the SDK is
 * not asked until Publish. `ready` is true only for a signed-in client, so a link opened signed out waits for sign-in.
 * `searchKey` is the router's search string: a card tap changes it and runs this again.
 */
export function FinishSetupLinkHost({ tcw, ready, searchKey, env = { location: window.location, history: window.history } }: {
  tcw: RegistryPublishClient | null;
  ready: boolean;
  searchKey: string;
  env?: RegistryPublishEnv;
}) {
  const [noticeOpen, setNoticeOpen] = useState(false);
  useEffect(() => {
    if (!ready || !tcw) return;
    void runFinishSetupIntent(tcw, env).then((outcome) => {
      if (outcome === "notice") setNoticeOpen(true);
    });
    // `env` is the page's own location and history; only the client, sign-in state and address decide a run.
  }, [ready, tcw, searchKey]);
  return (
    <FinishSetupNotice
      open={noticeOpen && ready && tcw !== null}
      onCancel={() => setNoticeOpen(false)}
      onPublish={() => {
        setNoticeOpen(false);
        if (tcw) void publishRegistryRecord(tcw, env.location.origin);
      }}
    />
  );
}
