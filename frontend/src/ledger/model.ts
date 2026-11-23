import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";

export const LEDGER_PREFIX = "xyz.tinycloud.tinyapps.tasks/";
export const LEDGER_APP_ID = "xyz.tinycloud.tinyapps.tasks";
export const LEDGER_STAGES = ["Asked", "Planned", "Building", "Merged", "Released", "Turned on", "Checked", "Dropped"] as const;
type Stage = (typeof LEDGER_STAGES)[number];

export interface LedgerRecord { key: string; value: unknown }
export interface LedgerRow {
  id: string;
  title: string;
  stage: Stage | "Done by agent, not checked yet";
  stageSince: string;
  agentLabel: string;
  condition?: string;
  note?: string;
  evidence?: string;
  checkedBy?: string;
  blockedBy: number;
  blocks: number;
}
interface TaskSnapshot {
  row: LedgerRow;
  order: string;
  blockedBy: string[];
  blocks: string[];
}
const OBJECT = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const TASK_ID = /^[a-zA-Z0-9][a-zA-Z0-9._~:+@=,-]{0,199}$/;
const AGENT_ID = /^[a-f0-9]{16}$/;
const UTC = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/;
const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;

/** Display only: never turn agent text into markup, instructions or navigation. Mask before capping. */
export function ledgerText(value: string, cap: number): string {
  return value
    .replace(/https?:\/\/[^\s<>"']+/gi, (url) => url.split(/[?#]/, 1)[0]!.replace(/(https?:\/\/)[^/@]+:[^/@]+@/i, "$1[masked]@"))
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, "[masked]")
    .replace(/\bBearer\s+[a-zA-Z0-9._~+/=-]+/gi, "Bearer [masked]")
    .replace(/\b(?:sk-[a-zA-Z0-9_-]{16,}|(?:gh[pousr]_|github_pat_)[a-zA-Z0-9_]{16,}|xox[baprs]-[a-zA-Z0-9-]+|AKIA[A-Z0-9]{16}|eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+)\b/g, "[masked]")
    .replace(/\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|private[_-]?key)\s*[:=]\s*["']?[^\s,"';]+["']?/gi, "[masked]")
    .replace(/\b(?:0x)?[a-fA-F0-9]{64}\b/g, "[masked]")
    .replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, " ")
    .trim().slice(0, cap);
}
function utc(value: unknown): value is string {
  return typeof value === "string" && UTC.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 19) === value.slice(0, 19);
}
function eventOrder(filename: string): string | null {
  const match = /^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)(\d{3,9})Z-([a-z0-9-]+)\.json$/.exec(filename);
  if (!match) return null;
  const [, year, month, day, hour, minute, second, fraction, suffix] = match;
  if (!utc(`${year}-${month}-${day}T${hour}:${minute}:${second}.${fraction}Z`)) return null;
  return `${year}${month}${day}T${hour}${minute}${second}${fraction!.padEnd(9, "0")}Z-${suffix}`;
}
function references(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.slice(0, 20).filter((ref): ref is string => {
    if (typeof ref !== "string") return false;
    const parts = ref.split("/");
    return parts.length === 2 && AGENT_ID.test(parts[0]!) && TASK_ID.test(parts[1]!);
  }))];
}

/** Fold complete snapshots by append ID, never by stage rank. Identity comes from the granted folder. */
export function foldLedger(records: readonly LedgerRecord[], now: number, agentNames: ReadonlyMap<string, string> = new Map()): LedgerRow[] {
  const hashes = new Map<string, string>();
  function canonicalDid(value: unknown, folder: string): string | null {
    if (typeof value !== "string" || value.length > 2048) return null;
    const did = value.split("#", 1)[0]!;
    if (!/^did:[a-z0-9]+:[a-zA-Z0-9._:%-]+$/.test(did)) return null;
    let hash = hashes.get(did);
    if (!hash) {
      hash = bytesToHex(sha256(new TextEncoder().encode(did))).slice(0, 16);
      hashes.set(did, hash);
    }
    return hash === folder ? did : null;
  }
  const tasks = new Map<string, TaskSnapshot>();
  const checks = new Map<string, { order: string; at: string; evidence: string; checkedBy: string }>();
  for (const record of records) {
    if (!record.key.startsWith(`${LEDGER_PREFIX}task/`) || !OBJECT(record.value)) continue;
    const parts = record.key.slice(`${LEDGER_PREFIX}task/`.length).split("/");
    const [folder, task] = parts;
    if (!folder || !AGENT_ID.test(folder)) continue;
    const value = record.value;
    if (parts.length === 5 && task === "checks") {
      const [, , doer, taskId, filename] = parts;
      if (!doer || !AGENT_ID.test(doer) || doer === folder || !taskId || !TASK_ID.test(taskId)) continue;
      const order = eventOrder(filename!);
      const checker = canonicalDid(value.checkedBy, folder);
      if (!order || !checker || !utc(value.at) || Date.parse(value.at) > now || typeof value.evidence !== "string") continue;
      const evidence = ledgerText(value.evidence, 200);
      if (!evidence) continue;
      const id = `${doer}/${taskId}`;
      const name = ledgerText(agentNames.get(checker) ?? "", 60);
      const checkedBy = name ? `${name} · ${folder}` : `Agent ${folder}`;
      if (!checks.has(id) || checks.get(id)!.order < order) checks.set(id, { order, at: value.at, evidence, checkedBy });
      continue;
    }
    if (parts.length !== 3 || !task || !TASK_ID.test(task) || value.taskId !== task) continue;
    const order = eventOrder(parts[2]!);
    const did = canonicalDid(value.agent, folder);
    if (!order || !did || typeof value.title !== "string" || !utc(value.stageSince) || Date.parse(value.stageSince) > now || !LEDGER_STAGES.includes(value.stage as Stage)) continue;
    const title = ledgerText(value.title, 200);
    if (!title) continue;
    const id = `${folder}/${task}`;
    if (tasks.has(id) && tasks.get(id)!.order >= order) continue;
    const name = agentNames.get(did) ?? (typeof value.agentName === "string" ? value.agentName : "");
    const safeName = ledgerText(name, 60);
    const condition = typeof value.condition === "string" && /^(Waiting on you|Blocked: .+|Off on purpose: .+)$/.test(value.condition) ? ledgerText(value.condition, 500) : undefined;
    tasks.set(id, {
      order,
      blockedBy: references(value.blockedBy),
      blocks: references(value.blocks),
      row: {
        id, title, stage: value.stage === "Checked" ? "Done by agent, not checked yet" : value.stage as Stage,
        stageSince: value.stageSince,
        agentLabel: safeName ? `${safeName} · ${folder}` : `Agent ${folder}`,
        condition,
        note: typeof value.note === "string" ? ledgerText(value.note, 500) : undefined,
        blockedBy: 0, blocks: 0,
      },
    });
  }
  const visible = new Map<string, TaskSnapshot>();
  for (const [id, snapshot] of tasks) {
    const check = checks.get(id);
    if (check && check.order > snapshot.order && snapshot.row.stage !== "Dropped") {
      snapshot.row.stage = "Checked";
      snapshot.row.stageSince = check.at;
      snapshot.row.evidence = check.evidence;
      snapshot.row.checkedBy = check.checkedBy;
    }
    const done = snapshot.row.stage === "Checked" || snapshot.row.stage === "Done by agent, not checked yet" || snapshot.row.stage === "Dropped";
    if (done && now - Date.parse(snapshot.row.stageSince) > THIRTY_DAYS) continue;
    visible.set(id, snapshot);
  }
  for (const snapshot of visible.values()) {
    snapshot.row.blockedBy = snapshot.blockedBy.filter((ref) => ref !== snapshot.row.id && visible.has(ref)).length;
    snapshot.row.blocks = snapshot.blocks.filter((ref) => ref !== snapshot.row.id && visible.has(ref)).length;
  }
  return [...visible.values()].sort((a, b) => b.order.localeCompare(a.order) || a.row.id.localeCompare(b.row.id)).map(({ row }) => row);
}
