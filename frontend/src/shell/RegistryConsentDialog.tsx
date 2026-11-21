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
  pendingRegistryConsent,
  registerRegistryConsentHost,
  subscribeRegistryConsent,
} from "@/lib/registryConsent/broker";
import { REGISTRY_CONSENT_COPY } from "@/lib/registryConsent/copy";
import type { RegistryPublishPreview } from "@/lib/registryConsent/adapter";

/** `0x…abcd`: the owner's address from their did:pkh, short. The SDK hands the whole DID. */
export function shortSubject(subject: string): string {
  const address = subject.slice(subject.lastIndexOf(":") + 1);
  return address.length > 4 ? `0x…${address.slice(-4)}` : address;
}

/**
 * Asks before the owner's registry record is published (TC-3547). It shows what the SDK will publish, from the preview
 * the SDK hands over, and answers the SDK's pending consent: Publish and continue is true; Not now, Escape and a tap
 * outside are false. It is mounted once, at the app root, for as long as the app runs. All words are in
 * lib/registryConsent/copy.ts.
 */
export function RegistryConsentDialog() {
  const preview = useSyncExternalStore(subscribeRegistryConsent, pendingRegistryConsent, () => null);
  useEffect(() => registerRegistryConsentHost(), []);
  return (
    <AlertDialog open={preview !== null} onOpenChange={(open) => { if (!open) answerRegistryConsent(false); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{REGISTRY_CONSENT_COPY.title}</AlertDialogTitle>
          <AlertDialogDescription>{REGISTRY_CONSENT_COPY.body}</AlertDialogDescription>
        </AlertDialogHeader>
        {preview && <PreviewRows preview={preview} />}
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => answerRegistryConsent(false)}>{REGISTRY_CONSENT_COPY.notNow}</AlertDialogCancel>
          <AlertDialogAction onClick={() => answerRegistryConsent(true)}>{REGISTRY_CONSENT_COPY.publish}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function PreviewRows({ preview }: { preview: RegistryPublishPreview }) {
  const labels = REGISTRY_CONSENT_COPY.previewLabels;
  const rows: Array<[string, string]> = [
    [labels.subject, shortSubject(preview.subject)],
    [labels.nodeDid, preview.nodeDid],
    [labels.nodeOrigin, preview.nodeOrigin],
    [labels.space, preview.space],
  ];
  return (
    <dl className="grid gap-2 text-sm" data-testid="registry-consent-preview">
      {rows.map(([label, value]) => (
        <div key={label}>
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="break-all font-mono">{value}</dd>
        </div>
      ))}
    </dl>
  );
}
