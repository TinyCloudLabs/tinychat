// Contract-first declarations for the per-owner identity; implementation follows in C1.
export interface CourierIdentity {
  did: string;
  publicJwk: JsonWebKey;
  signer: unknown;
}

export declare function courierIdentity(owner: string): Promise<CourierIdentity>;
