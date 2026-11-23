import type { CourierGrant } from "./grant-store";
import type { CourierIdentity } from "./identity";

export interface CourierContext {
  identity: CourierIdentity;
  grant: CourierGrant;
  host: string;
  kv: unknown;
}
export interface PairPending { handle: string; peerDid: string; artifactB: string; expiresAt: number }
export interface PairedPeer { handle: string; peerDid: string; delegation: unknown; delegationExpiresAt: number }
export interface CourierInbound { threadId: string; messageId: string; intent: "ask" | "inform" | "request" | "task"; text: string; sentAt: number }

export declare function courierContext(owner: string, grant: CourierGrant): Promise<CourierContext>;
export declare function acceptPairing(ctx: CourierContext, artifactA: string): Promise<PairPending>;
export declare function finalizePairing(ctx: CourierContext, pending: PairPending, artifactC: string): Promise<PairedPeer>;
export declare function unpair(ctx: CourierContext, peer: PairedPeer): Promise<void>;
export declare function renewPeer(ctx: CourierContext, peer: PairedPeer): Promise<PairedPeer>;
export declare function listInbound(ctx: CourierContext, peer: PairedPeer, since?: string): Promise<CourierInbound[]>;
export declare function sendMessage(ctx: CourierContext, peer: PairedPeer, threadId: string, text: string): Promise<{ messageId: string }>;
