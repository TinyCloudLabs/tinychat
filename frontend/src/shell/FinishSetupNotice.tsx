import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { readRegistryUnregistered, type RegistryPublishClient } from "@/lib/registryConsent/adapter";
import { finishSetupBannerVisible } from "@/lib/registryConsent/bannerGate";
import { FINISH_SETUP_NOTICE_COPY } from "@/lib/registryConsent/copy";
import { registryDismissedStore, type DismissedStore } from "@/lib/registryConsent/dismissed";
import { hasFinishSetupRegistryIntent, publishRegistryRecord, runFinishSetupIntent, type RegistryPublishEnv } from "@/lib/registryConsent/intent";
import { registryNudgedStore, type NudgedStore } from "@/lib/registryConsent/nudged";
import { canOpenRegistrySetupLink } from "@/lib/registryConsent/setupLink";
import { appPlatform, type AppPlatform } from "@/lib/platform";

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
 *
 * The notice belongs to the client it was opened for. It closes, and nothing is kept, when the client changes or sign-in
 * ends, so the next account never sees it and Publish never signs for a different account. The query is gone from the
 * address by then, so the next account's run finds no link.
 *
 * Once per owner per device (nudged.ts), a signed-in web owner the registry does not know, and who has not published from
 * this device (the Home card's gate), sees the same notice without a link. The flag is written when the notice shows, so
 * Cancel and a reload do not ask again. A finish-setup link counts as that one ask: it writes the flag too, so the notice
 * never opens twice. Phones and the desktop app keep only the card.
 */
export function FinishSetupLinkHost({
  tcw, ready, searchKey, env = { location: window.location, history: window.history }, dismissed = registryDismissedStore,
  nudged = registryNudgedStore, unregistered = readRegistryUnregistered, platform = appPlatform(),
}: {
  tcw: RegistryPublishClient | null;
  ready: boolean;
  searchKey: string;
  env?: RegistryPublishEnv;
  dismissed?: DismissedStore;
  nudged?: NudgedStore;
  /** The registry's verdict for the owner: true only for "unregistered" and not offline. */
  unregistered?: (tcw: RegistryPublishClient) => Promise<boolean>;
  platform?: AppPlatform;
}) {
  const [noticeFor, setNoticeFor] = useState<RegistryPublishClient | null>(null);
  // A new client, no client, or an ended sign-in drops the notice.
  useEffect(() => () => setNoticeFor(null), [ready, tcw]);
  useEffect(() => {
    if (!ready || !tcw) return;
    // A finish-setup link is this owner's one ask, whether it publishes at once (card) or shows the notice (pasted link).
    if (tcw.did && hasFinishSetupRegistryIntent(env.location.search)) nudged.write(tcw.did);
    void runFinishSetupIntent(tcw, env, undefined, dismissed).then((outcome) => {
      if (outcome === "notice") setNoticeFor(tcw);
    });
    // `env` is the page's own location and history; only the client, sign-in state and address decide a run.
  }, [ready, tcw, searchKey]);
  // Declared after the link effect, so a link's flag is written before this reads it. Runs per client, not per address.
  useEffect(() => {
    const subject = tcw?.did;
    if (!ready || !tcw || !subject || platform !== "web" || nudged.read(subject)) return;
    let alive = true;
    void finishSetupBannerVisible(tcw, unregistered, () => canOpenRegistrySetupLink(platform), dismissed).then((visible) => {
      if (!alive || !visible || nudged.read(subject)) return;
      nudged.write(subject);
      setNoticeFor(tcw);
    }, () => {});
    return () => { alive = false; };
    // The verdict lookup and the stores are the page's own; only the client and sign-in state decide a run.
  }, [ready, tcw]);
  // An answer that arrives after the client changed names the old client, so it never shows for the new one.
  const open = ready && tcw !== null && noticeFor === tcw;
  return (
    <FinishSetupNotice
      open={open}
      onCancel={() => setNoticeFor(null)}
      onPublish={() => {
        setNoticeFor(null);
        if (open && tcw) void publishRegistryRecord(tcw, env.location.origin, undefined, dismissed);
      }}
    />
  );
}
