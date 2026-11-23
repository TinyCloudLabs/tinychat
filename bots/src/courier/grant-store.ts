// Contract-first declarations for owner grants; implementation follows in C1.
export interface CourierGrant {
  raw: unknown;
  expiresAt: number;
}

export interface CourierGrantStore {
  get(owner: string): Promise<CourierGrant | undefined>;
  put(owner: string, grant: CourierGrant): Promise<void>;
  delete(owner: string): Promise<void>;
}

/** Gateway-owned directory beside the budget file; key comes from sealKeyFromDstack. */
export declare function createCourierGrantStore(dir: string, sealKey: Uint8Array): CourierGrantStore;
