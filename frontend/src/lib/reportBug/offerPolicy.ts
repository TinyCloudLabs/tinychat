// When a screenshot may open the Report a bug sheet by itself (Sam: easy to dismiss, never nagging).
// The Settings row opens it regardless.
export const OFFER = {
  /** Screenshots right after launch are of the boot and sign-in screens. */
  launchQuietMs: 3_000,
  /** After "Not now" (or any close without sending). */
  cooldownMs: 10 * 60_000,
  /** This many closes in a row without a send: no more offers until the app restarts. */
  maxDismissals: 3,
} as const;

export interface OfferGate { locked: boolean; sheetOpen: boolean }

export interface OfferPolicy {
  /** Whether screenshot `id` should open the sheet now; an id is offered at most once. */
  offer(id: string, now: number, gate: OfferGate): boolean;
  /** The sheet closed without a send. */
  dismissed(now: number): void;
  sent(): void;
}

export function createOfferPolicy(launchedAt: number): OfferPolicy {
  const seen = new Set<string>();
  let quietUntil = launchedAt + OFFER.launchQuietMs;
  let streak = 0;
  return {
    offer(id: string, now: number, gate: OfferGate): boolean {
      if (seen.has(id)) return false;
      seen.add(id);
      return !gate.locked && !gate.sheetOpen && streak < OFFER.maxDismissals && now >= quietUntil;
    },
    dismissed(now: number) {
      streak++;
      quietUntil = Math.max(quietUntil, now + OFFER.cooldownMs);
    },
    sent() {
      streak = 0;
    },
  };
}

