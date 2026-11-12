// TC-2808: supervisor-owned journal and receipt barrier, outside all sandbox binds.
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { recoverMessageAddress } from "viem";
import type { BotLayout } from "./layout";

const DOMAIN = "tinychat.bot-history.storage/v1\n";
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
export interface HistoryOptions { signerDid: string; host: string; policy: "notice-then-expiry-30-days" }
export interface JournalBatch { v: 1; generation: string; seq: number; challenge: string; record: unknown }
export interface ExpiryNotice { id: string; expiresAt: number; firstAttemptAt: number; deliveredAt?: number; deleteAt?: number }
export function noticeDeadline(notice: ExpiryNotice, renderedAt: number): number {
  if (notice.deleteAt !== undefined) return notice.deleteAt;
  const base = Math.max(notice.expiresAt, notice.firstAttemptAt) + 30 * 86_400_000;
  return renderedAt > base ? renderedAt + 30 * 86_400_000 : base;
}
export interface StagedHistory { seq: number; challenge: string; batchHash: string; envelope: unknown }
interface Journal { v: 1; generation: string; owner: string; legacyPending: boolean; batches: JournalBatch[]; receipts: unknown[]; draft?: { text: string }; notice?: ExpiryNotice; permissionValidUntil?: number; staged?: StagedHistory }
const MAX_JOURNAL_BYTES = 8 * 1024 * 1024;
export class HistoryJournal {
  readonly #path: string;
  #state: Journal;
  constructor(readonly layout: BotLayout, readonly options: HistoryOptions) {
    this.#path = join(layout.dataDir, "history.json");
    if (existsSync(this.#path)) {
      if (!lstatSync(this.#path).isFile()) throw new Error("invalid_history_journal");
      this.#state = JSON.parse(readFileSync(this.#path, "utf8"));
      if (this.#state.v !== 1 || !Array.isArray(this.#state.batches) || !Array.isArray(this.#state.receipts)
        || this.#state.receipts.length > this.#state.batches.length || !/^[a-f0-9]{32}$/.test(this.#state.generation)
        || hash(this.#state.owner) !== layout.botId || this.#state.batches.some((batch, i) => batch.seq !== i + 1 || batch.generation !== this.#state.generation || !/^[a-f0-9]{64}$/.test(batch.challenge))) throw new Error("invalid_history_journal");
      const notice = this.#state.notice;
      if (notice && (!/^[a-f0-9]{64}$/.test(notice.id) || !Number.isFinite(notice.expiresAt) || !Number.isFinite(notice.firstAttemptAt)
        || notice.firstAttemptAt < notice.expiresAt || (notice.deliveredAt !== undefined && (!Number.isFinite(notice.deliveredAt)
          || notice.deliveredAt < notice.firstAttemptAt || notice.deleteAt !== noticeDeadline({ ...notice, deleteAt: undefined }, notice.deliveredAt)))
        || (notice.deliveredAt === undefined && notice.deleteAt !== undefined))) throw new Error("invalid_history_notice");
      if (this.#state.draft) this.finishDraft({ type: "interrupted" });
    } else {
      this.#state = { v: 1, generation: randomBytes(16).toString("hex"), owner: "", legacyPending: existsSync(layout.stateSnapshot), batches: [], receipts: [] };
    }
  }
  #save() {
    mkdirSync(this.layout.dataDir, { recursive: true, mode: 0o700 });
    const file = openSync(this.#path + ".new", "w", 0o600);
    try { writeSync(file, JSON.stringify(this.#state)); fsyncSync(file); } finally { closeSync(file); }
    renameSync(this.#path + ".new", this.#path);
    const dir = openSync(this.layout.dataDir, "r");
    try { fsyncSync(dir); } finally { closeSync(dir); }
  }
  begin(owner: string, reserve: number) {
    if (hash(owner) !== this.layout.botId || (this.#state.owner && this.#state.owner !== owner)) throw new Error("history_owner_mismatch");
    if (Buffer.byteLength(JSON.stringify(this.#state)) + reserve > MAX_JOURNAL_BYTES) throw new Error("history_full");
    this.#state.owner = owner;
    this.#save();
  }
  append(record: unknown) {
    if (!this.#state.owner) throw new Error("history_owner_missing");
    const batch: JournalBatch = { v: 1, generation: this.#state.generation, seq: this.#state.batches.length + 1, challenge: randomBytes(32).toString("hex"), record };
    if (Buffer.byteLength(JSON.stringify(this.#state)) + Buffer.byteLength(JSON.stringify(batch)) > MAX_JOURNAL_BYTES) throw new Error("history_full");
    this.#state.batches.push(batch);
    this.#save();
  }
  startDraft() { this.#state.draft = { text: "" }; this.#save(); }
  delta(text: string) {
    if (!this.#state.draft) throw new Error("history_draft_missing");
    this.#state.draft.text += text;
    this.#save();
  }
  finishDraft(outcome: Record<string, unknown>) {
    if (!this.#state.draft) throw new Error("history_draft_missing");
    const text = this.#state.draft.text;
    delete this.#state.draft;
    this.append({ type: "assistant", text, outcome, at: new Date().toISOString() });
  }
  permissionExpired(expiresAt: number, owner: string, now = Date.now()) {
    if (!Number.isFinite(expiresAt) || expiresAt > now) throw new Error("invalid_permission_expiry");
    this.begin(owner, 0);
    if ((this.#state.permissionValidUntil ?? 0) > expiresAt) return;
    if (!this.#state.notice || this.#state.notice.expiresAt !== expiresAt) {
      this.#state.notice = { id: randomBytes(32).toString("hex"), expiresAt, firstAttemptAt: now };
      this.#save();
    }
  }
  permissionActive(validUntil: number, now = Date.now()) {
    if (!Number.isFinite(validUntil) || validUntil <= now) throw new Error("invalid_permission_expiry");
    if (validUntil < (this.#state.permissionValidUntil ?? 0)) return;
    this.#state.permissionValidUntil = validUntil;
    delete this.#state.notice; this.#save();
  }
  notice(): ExpiryNotice | undefined { return this.#state.notice ? { ...this.#state.notice } : undefined; }
  // Acknowledgment is a client-reported render; only backend receive time controls deletion.
  acknowledgeNotice(id: string, receivedAt: number, now = Date.now()) {
    const notice = this.#state.notice;
    if (!notice || notice.id !== id) throw new Error("notice_mismatch");
    if (notice.deliveredAt !== undefined) return;
    if (!Number.isFinite(receivedAt) || receivedAt > now || receivedAt < notice.firstAttemptAt) throw new Error("notice_date_mismatch");
    notice.deliveredAt = receivedAt; notice.deleteAt = noticeDeadline(notice, receivedAt);
    this.#save();
  }
  expiryDue(now = Date.now()): boolean {
    const notice = this.#state.notice;
    return !!notice && notice.deliveredAt !== undefined && notice.deleteAt !== undefined && now >= notice.deleteAt;
  }
  get legacyPending(): boolean { return this.#state.legacyPending; }
  messages() {
    return this.#state.batches.flatMap(batch => {
      const record = batch.record as { type?: string; text?: string; at?: string };
      return (record.type === "user" || record.type === "assistant") && typeof record.text === "string"
        ? [{ id: `history-${batch.generation}-${batch.seq}`, role: record.type === "user" ? "user" as const : "bot" as const, text: record.text, at: record.at ?? "" }] : [];
    });
  }
  stage(staged: StagedHistory) {
    const batch = this.#state.batches[this.#state.receipts.length];
    if (!batch || staged.seq !== batch.seq || staged.challenge !== batch.challenge || staged.batchHash !== hash(JSON.stringify(batch))) throw new Error("history_stage_mismatch");
    if (Buffer.byteLength(JSON.stringify(this.#state)) + Buffer.byteLength(JSON.stringify(staged)) > MAX_JOURNAL_BYTES) throw new Error("history_full");
    if (this.#state.staged && JSON.stringify(this.#state.staged) !== JSON.stringify(staged)) throw new Error("history_stage_conflict");
    this.#state.staged = staged; this.#save();
  }
  pending(): (JournalBatch & { staged?: StagedHistory }) | undefined {
    const batch = this.#state.batches[this.#state.receipts.length];
    return batch ? { ...batch, ...(this.#state.staged?.seq === batch.seq ? { staged: this.#state.staged } : {}) } : undefined;
  }
  get covered(): boolean { return !this.#state.draft && !this.#state.legacyPending && this.#state.batches.length > 0 && this.#state.receipts.length === this.#state.batches.length; }
  async verifyCoverage(): Promise<boolean> {
    if (!this.covered) return false;
    for (let i = 0; i < this.#state.receipts.length; i++) await this.#verify(this.#state.receipts[i], this.#state.batches[i]);
    return this.covered;
  }
  async #verify(receipt: unknown, batch: JournalBatch | undefined) {
    const { body, signature } = receipt as { body: Record<string, unknown>; signature: `0x${string}` };
    if (!batch || !body || typeof signature !== "string") throw new Error("invalid_history_receipt");
    const { owner, botId, generation, seq, challenge, batchHash, host, spaceId, ciphertextHash, v } = body;
    if (v !== 1 || owner !== this.#state.owner || botId !== this.layout.botId || generation !== batch.generation || seq !== batch.seq
      || challenge !== batch.challenge || batchHash !== hash(JSON.stringify(batch)) || host !== this.options.host
      || typeof spaceId !== "string" || !/^tinycloud:pkh:eip155:1:0x[a-fA-F0-9]{40}:applications$/.test(spaceId)
      || spaceId.split(":")[4]?.toLowerCase() !== this.#state.owner.split(":")[4]?.toLowerCase()
      || typeof ciphertextHash !== "string" || !/^[a-f0-9]{64}$/.test(ciphertextHash)) throw new Error("invalid_history_receipt");
    const signer = await recoverMessageAddress({ message: DOMAIN + JSON.stringify(body), signature });
    if (`did:pkh:eip155:1:${signer.toLowerCase()}` !== this.options.signerDid.toLowerCase()) throw new Error("history_wrong_signer");
  }
  async accept(receipt: unknown) {
    const batch = this.#state.batches[this.#state.receipts.length];
    await this.#verify(receipt, batch);
    // The await above may overlap a message append; the pending sequence must still be this batch.
    if (!batch || this.pending()?.challenge !== batch.challenge) throw new Error("history_receipt_stale");
    this.#state.receipts.push(receipt);
    delete this.#state.staged;
    this.#save();
  }
}
