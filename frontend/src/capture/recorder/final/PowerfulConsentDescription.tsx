import { POWERFUL_CONSENT_SMALL_PRINT } from "./finalCopy";

/** The Powerful consent body with its small print, for every dialog that asks. */
export function PowerfulConsentDescription({ body }: { body: string }) {
  return (
    <>
      {body}
      <small className="mt-1 block text-meta opacity-70" data-testid="powerful-consent-provider">{POWERFUL_CONSENT_SMALL_PRINT}</small>
    </>
  );
}
