import { useEffect, useSyncExternalStore } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  answerRegistryConsent,
  declineRegistryConsent,
  dismissRegistryConsent,
  pendingRegistryConsent,
  registerRegistryConsentHost,
  subscribeRegistryConsent,
} from "@/lib/registryConsent/broker";
import { REGISTRY_CONSENT_COPY } from "@/lib/registryConsent/copy";
import { previewRows } from "@/lib/registryConsent/preview";
import type { RegistryPublishPreview } from "@/lib/registryConsent/adapter";

/**
 * Asks before the owner's registry record is published (TC-3547). It shows what the SDK will publish, from the preview
 * the SDK hands over, and answers the SDK's pending consent: Publish and continue is true, the Not now button is false and is remembered for this owner.
 * Escape and a tap outside throw (the SDK treats that as declined and stores nothing). It is mounted once, at the app
 * root, for as long as the app runs. All words are in lib/registryConsent/copy.ts.
 */
export function RegistryConsentDialog() {
  const preview = useSyncExternalStore(subscribeRegistryConsent, pendingRegistryConsent, () => null);
  useEffect(() => registerRegistryConsentHost(), []);
  return (
    <AlertDialog open={preview !== null} onOpenChange={(open) => { if (!open) dismissRegistryConsent(); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{REGISTRY_CONSENT_COPY.title}</AlertDialogTitle>
          <AlertDialogDescription>{REGISTRY_CONSENT_COPY.body}</AlertDialogDescription>
        </AlertDialogHeader>
        {preview && <PreviewRows preview={preview} />}
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => declineRegistryConsent()}>{REGISTRY_CONSENT_COPY.notNow}</AlertDialogCancel>
          <AlertDialogAction onClick={() => answerRegistryConsent(true)}>{REGISTRY_CONSENT_COPY.publish}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function PreviewRows({ preview }: { preview: RegistryPublishPreview }) {
  return (
    <dl className="grid gap-2 text-sm" data-testid="registry-consent-preview">
      {previewRows(preview).map((row) => (
        <div key={row.key}>
          <dt className="text-muted-foreground">{row.label}</dt>
          <dd className="break-all">{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}
