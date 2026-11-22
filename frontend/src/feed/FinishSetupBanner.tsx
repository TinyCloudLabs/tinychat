import { useEffect, useState } from "react";
import { InfoIcon } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { finishSetupBannerVisible } from "@/lib/registryConsent/bannerGate";
import { FINISH_SETUP_BANNER_COPY } from "@/lib/registryConsent/copy";
import { FINISH_SETUP_INTENT_SEARCH } from "@/lib/registryConsent/intent";
import type { RegistryPublishClient } from "@/lib/registryConsent/adapter";

/**
 * Home's "finish setup" card (TC-3547). Shown only when the gate says so: the account has no registry record and has not
 * answered "Not now" (the SDK stores that, so the card stays away across sign-ins). Its action goes to the same
 * `?finish-setup=registry` address a pasted link uses, so the page runs one path: the query is removed, then the SDK is
 * asked to publish past an earlier "Not now". Off with the consent switch, so it renders nothing in production.
 */
export function FinishSetupBanner({ tcw, visible = finishSetupBannerVisible }: {
  tcw: RegistryPublishClient | null;
  visible?: (tcw: RegistryPublishClient | null) => Promise<boolean>;
}) {
  const navigate = useNavigate();
  const [show, setShow] = useState(false);
  // Read once when this client loads, not on every render.
  useEffect(() => {
    let alive = true;
    setShow(false);
    void visible(tcw).then((answer) => { if (alive) setShow(answer); }, () => {});
    return () => { alive = false; };
  }, [tcw, visible]);
  if (!show) return null;
  const copy = FINISH_SETUP_BANNER_COPY;
  return (
    <div role="status" data-testid="finish-setup-banner" className="mb-4 flex items-start gap-3 rounded-2xl bg-card px-4 py-3 text-sm leading-[1.45] shadow-[inset_0_0_0_1px_hsl(var(--border))]">
      <InfoIcon aria-hidden className="mt-px size-5 shrink-0 text-muted-foreground" />
      <div className="min-w-0">
        <p><b className="font-semibold">{copy.lead}</b> {copy.support}</p>
        <button type="button" onClick={() => { setShow(false); navigate({ search: FINISH_SETUP_INTENT_SEARCH }); }} className="mt-2 min-h-11 underline">{copy.action}</button>
      </div>
    </div>
  );
}
