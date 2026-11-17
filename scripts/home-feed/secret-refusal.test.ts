/**
 * The mirror posts and revises only what the board's own write guard lets onto the board. A board record that holds a
 * secret or an approval link anyway (written before a pattern existed, or by anything that skips the guard) stays on the
 * board, and the refusal names the card and the kind of finding, never the value.
 */
import { afterEach, expect, test } from "bun:test";
import { listFeedCardHistory } from "@tinycloud/sdk-services/feed";
import { boardKey } from "@tinyboilerplate/core/feed/sitrep";
import type { BoardRecord } from "@tinyboilerplate/core/feed/sitrep";
import { homeMirrorDiagnostic, publishHomeMirror, readHomeMirrorSource } from "./bridge";
import type { HomeMirrorPublishInput } from "./bridge-types";
import { boardCard, inventoryPlan, postMany } from "./inventory";
import { boardRecord, mirrorNode, NOW, SOURCE, take } from "./mirror-node.fixture";
import type { MirrorNode } from "./mirror-node.fixture";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const action of cleanup.splice(0).reverse()) await action(); });
async function node(): Promise<MirrorNode> { const f = await mirrorNode(); cleanup.push(() => f.close()); return f; }

const NOW_MS = Date.parse(NOW);
const KEY_PART = "q".repeat(43);
const LINK = `https://openkey.so/a/${"a".repeat(26)}#v=4&k=${KEY_PART}&c=bafkrei${"a".repeat(52)}`;
const BEARER = `Bearer ${"z".repeat(30)}`;
// Through JSON, as a board copy is read back.
const ask = (id: string, patch: Record<string, unknown> = {}): BoardRecord => JSON.parse(JSON.stringify(boardRecord("ask", id, patch)));
const rowOf = (record: BoardRecord) => ({ key: boardKey(record.kind, record.id), record });
const reported = (value: unknown) => JSON.stringify(value);

test("a record that holds a one-tap link or a bearer token is refused whole, on every kind the mirror posts, and the refusal names the card and the finding but not the value", () => {
  for (const kind of ["ask", "incident", "progress", "task", "work"] as const) {
    for (const [field, value, finding] of [["body", `Approve at ${LINK}`, "an OpenKey one-tap approval link"], ["body", `Use ${BEARER} to sign in`, "a bearer token"]] as const) {
      const record = JSON.parse(JSON.stringify(boardRecord(kind, `s-${kind}`, { [field]: value }))) as BoardRecord;
      let refusal: unknown;
      try { boardCard(rowOf(record), [record], NOW_MS); } catch (error) { refusal = error; }
      expect(refusal, `${kind} ${finding}`).toBeDefined();
      const { error } = homeMirrorDiagnostic(refusal);
      expect(error.detail).toBe(`${kind}/s-${kind}: ${finding}`);
      expect(reported(error)).not.toContain(KEY_PART);
      expect(reported(error)).not.toContain("zzzzzz");
    }
  }
});

test("publishing a flagged board record posts nothing to Home", async () => {
  const f = await node();
  const clean = ask("p1"), flagged = ask("p1", { body: `Approve at ${LINK}` });
  take(await f.legacy.put(boardKey("ask", "p1"), JSON.stringify(flagged), { prefix: "", contentType: "application/json" }));
  const source = await readHomeMirrorSource(f.ctx, SOURCE);
  const input: HomeMirrorPublishInput = {
    source: { ...source, label: "Rocinante" }, card: boardCard(rowOf(clean), [clean], NOW_MS),
    legacy: { spaceId: f.ctx.legacySpaceId, fullKey: boardKey("ask", "p1"), record: flagged },
  };
  const refusal = await publishHomeMirror(f.ctx, input).then(() => undefined, (error: unknown) => error);
  expect(refusal).toBeDefined();
  expect(homeMirrorDiagnostic(refusal).error.detail).toBe("ask/p1: an OpenKey one-tap approval link");
  expect(take(await listFeedCardHistory(f.output)).cards).toHaveLength(0);
});

test("a card already mirrored is not revised once its board record holds a flagged string, and the rest of the run goes on", async () => {
  const f = await node();
  const keep = ask("r1"), other = ask("r2");
  const run = (records: BoardRecord[]) => postMany(f.ctx, { sourceId: SOURCE, label: "Rocinante", rows: records.map(rowOf), now: NOW_MS });
  expect((await run([keep, other])).map((item) => item.outcome)).toEqual(["posted", "posted"]);
  const later = await run([ask("r1", { body: `Use ${BEARER}` }), other]);
  expect(later.map((item) => item.outcome)).toEqual(["refused", "already"]);
  expect(later[0]?.detail).toBe("ask/r1: a bearer token");
  expect(reported(later)).not.toContain("zzzzzz");
});

test("a dry run lists a flagged record as left out, with its card and finding, and still plans the others", () => {
  const plan = inventoryPlan([rowOf(ask("d1")), rowOf(ask("d2", { body: `Approve at ${LINK}` }))], NOW_MS);
  expect(plan.items.map((item) => item.id)).toEqual(["d1"]);
  expect(plan.refused).toEqual([{ key: boardKey("ask", "d2"), reason: "flagged", detail: "ask/d2: an OpenKey one-tap approval link" }]);
});

test("a card whose id is itself the secret is named by neither its id nor its board key", async () => {
  const id = `lin_api_${"k".repeat(30)}`;
  const record = ask(id);
  const plan = inventoryPlan([rowOf(record)], NOW_MS);
  expect(plan.refused).toEqual([{ key: "(key withheld)", reason: "flagged", detail: "ask/(id withheld): a Linear API key" }]);
  const f = await node();
  const [item] = await postMany(f.ctx, { sourceId: SOURCE, label: "Rocinante", rows: [rowOf(record)], now: NOW_MS });
  expect(item?.outcome).toBe("refused");
  expect(reported([plan, item])).not.toContain("kkkkkk");
});
