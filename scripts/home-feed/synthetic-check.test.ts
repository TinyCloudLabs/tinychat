import { afterEach, expect, test } from "bun:test";
import { listFeedCardHistory } from "@tinycloud/sdk-services/feed";
import { boardKey } from "@tinyboilerplate/core/feed/sitrep";
import { homeMirrorDiagnostic, publishHomeMirror } from "./bridge";
import { boardCard, boardCardIdentity } from "./inventory";
import { mirrorNode, SOURCE, take } from "./mirror-node.fixture";
import type { MirrorNode } from "./mirror-node.fixture";
import { runSyntheticCheck, runSyntheticCheckCli, SYNTHETIC_ID, syntheticRecord } from "./synthetic-check";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const action of cleanup.splice(0).reverse()) await action(); });
const KEY = boardKey("ask", SYNTHETIC_ID);

async function node(space?: string): Promise<MirrorNode> { const f = await mirrorNode(space ? { space } : {}); cleanup.push(() => f.close()); return f; }
async function leftovers(f: MirrorNode) {
  return {
    cards: take(await listFeedCardHistory(f.output)).cards.length,
    bindings: Number(take(await f.owner.query("SELECT COUNT(*) FROM feed_sitrep_mirrors")).rows[0]![0]),
    board: f.values.has(KEY),
  };
}

test("the check posts the test ask, reads it back from Home, the binding and the board, and removes all three", async () => {
  const f = await node();
  const result = await runSyntheticCheck(f.ctx, f.legacy, { sourceId: SOURCE });
  expect(result).toMatchObject({ ok: true, cardId: boardCardIdentity(KEY).cardId });
  expect(await leftovers(f)).toEqual({ cards: 0, bindings: 0, board: false });
  // Twice in a row passes: it leaves nothing behind that the next run trips over.
  await runSyntheticCheck(f.ctx, f.legacy, { sourceId: SOURCE });
  expect(await leftovers(f)).toEqual({ cards: 0, bindings: 0, board: false });
});

test("what a stopped run left behind is removed first, and the check still passes", async () => {
  const f = await node();
  // A run stopped after posting: the test card, its binding and the board copy are all there.
  const record = syntheticRecord();
  await publishHomeMirror(f.ctx, { source: { ...f.source, label: "Monitoring" }, card: boardCard({ key: KEY, record }, [record], Date.parse("2026-11-13T00:00:00.000Z")), legacy: { spaceId: f.space, fullKey: KEY, record } });
  expect(await leftovers(f)).toEqual({ cards: 1, bindings: 1, board: true });
  await runSyntheticCheck(f.ctx, f.legacy, { sourceId: SOURCE });
  expect(await leftovers(f)).toEqual({ cards: 0, bindings: 0, board: false });
});

test("a failed post still cleans up and reports a non-zero exit", async () => {
  const f = await node();
  // The board copy comes back without the card's UUID: the mirror refuses, and nothing is left behind.
  f.filterPuts((key, text) => key === KEY ? JSON.stringify({ ...JSON.parse(text), cardUuid: undefined }) : text);
  let failure: unknown;
  try { await runSyntheticCheck(f.ctx, f.legacy, { sourceId: SOURCE }); } catch (error) { failure = error; }
  expect(failure).toBeDefined();
  expect(homeMirrorDiagnostic(failure).exitCode).not.toBe(0);
  expect(await leftovers(f)).toEqual({ cards: 0, bindings: 0, board: false });
});

test("the production owner's space is refused before any node call", async () => {
  const production = "tinycloud:pkh:eip155:1:0xd559CCd9EB87c530A9a349262669386dE93cf412:applications";
  const f = await node(production);
  let failure: unknown;
  try { await runSyntheticCheck(f.ctx, f.legacy, { sourceId: SOURCE }); } catch (error) { failure = error; }
  expect(homeMirrorDiagnostic(failure)).toMatchObject({ exitCode: 2, error: { message: "The synthetic check runs only in a QA owner space" } });
  expect(f.calls()).toEqual([]);
  const errors: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string) => { errors.push(String(chunk)); return true; }) as typeof process.stderr.write;
  try {
    expect(await runSyntheticCheckCli(["--tc-home", "/nonexistent", "--profile", "qa", "--owner-space", production, "--legacy-space", production, "--source", SOURCE])).toBe(2);
    expect(await runSyntheticCheckCli([])).toBe(2);
  } finally { process.stderr.write = write; }
  expect(JSON.parse(errors[0]!)).toMatchObject({ error: { message: "The synthetic check runs only in a QA owner space" } });
  expect(JSON.parse(errors[1]!)).toMatchObject({ error: { step: "arguments" } });
});
