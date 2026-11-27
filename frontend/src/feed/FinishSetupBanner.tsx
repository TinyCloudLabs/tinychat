import { useEffect, useState } from "react";
import { InfoIcon } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { finishSetupBannerVisible } from "@/lib/registryConsent/bannerGate";
import { FINISH_SETUP_BANNER_COPY } from "@/lib/registryConsent/copy";
import { registryDismissedStore, type DismissedStore } from "@/lib/registryConsent/dismissed";
import { FINISH_SETUP_CARD_STATE, FINISH_SETUP_INTENT_SEARCH } from "@/lib/registryConsent/intent";
import type { RegistryPublishClient } from "@/lib/registryConsent/adapter";

/**
 * Home's "finish setup" card (TC-3547). Shown only when the gate says so: the account has no registry record, the record
 * was not published from this device (dismissed.ts), and this app can open TinyCloud One. The button writes nothing: it
 * goes to the `?finish-setup=registry` address a pasted link uses, with a router state marker that says the owner just
 * read the card. The page removes the query and, with the marker, asks the SDK to publish at once (a link without it shows
 * the notice first). Only an answer of "published" or "already-current" writes the account's flag and hides the card, for
 * that account on this device, through sign-out too. A refused signature, "unavailable" or "needs-one" leaves the card
 * showing, and on "needs-one" the owner is sent to TinyCloud One.
 */
export function FinishSetupBanner({ tcw, visible = finishSetupBannerVisible, dismissed = registryDismissedStore }: {
  tcw: RegistryPublishClient | null;
  visible?: (tcw: RegistryPublishClient | null) => Promise<boolean>;
  dismissed?: DismissedStore;
}) {
  const navigate = useNavigate();
  const [show, setShow] = useState(false);
  // The device's flag changes when a publish succeeds (intent.ts): read the answer again so the card hides at once.
  const [flagChanges, setFlagChanges] = useState(0);
  useEffect(() => dismissed.subscribe(() => setFlagChanges((count) => count + 1)), [dismissed]);
  // Read when this client loads and when the flag changes, not on every render.
  useEffect(() => {
    let alive = true;
    setShow(false);
    void visible(tcw).then((answer) => { if (alive) setShow(answer); }, () => {});
    return () => { alive = false; };
  }, [tcw, visible, flagChanges]);
  if (!show) return null;
  const copy = FINISH_SETUP_BANNER_COPY;
  return (
    <div role="status" data-testid="finish-setup-banner" className="mb-4 flex items-start gap-3 rounded-2xl bg-card px-4 py-3 text-sm leading-[1.45] shadow-[inset_0_0_0_1px_hsl(var(--border))]">
      <InfoIcon aria-hidden className="mt-px size-5 shrink-0 text-muted-foreground" />
      <div className="min-w-0">
        <p className="font-semibold">{copy.lead}</p>
        <p>{copy.support}</p>
        <button type="button" onClick={() => navigate({ search: FINISH_SETUP_INTENT_SEARCH }, { state: FINISH_SETUP_CARD_STATE })} className="mt-2 min-h-11 underline">{copy.action}</button>
      </div>
    </div>
  );
}
