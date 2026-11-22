// TC-3808: a delete of the working state that stops part-way leaves the conversation id, so the mark of owner data the
// conversation read stays with the state that holds it.
import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { botLayout } from "../layout";
import { botIdFor } from "../owner";
import { conversationFile } from "../reads";
import { removeWorkingState } from "../retention";

test.skipIf(process.getuid?.() === 0)("a delete that fails inside the conversation state keeps the conversation id", async () => {
  const dir = mkdtempSync(join(tmpdir(), "retention-order-"));
  const roots = { dataRoot: join(dir, "data"), runRoot: join(dir, "run"), egressRoot: join(dir, "egress") };
  const layout = botLayout(botIdFor(`did:pkh:eip155:1:0x${"44".repeat(20)}`), roots);
  mkdirSync(join(layout.stateSnapshot, "locked"), { recursive: true });
  writeFileSync(join(layout.stateSnapshot, "locked", "session.jsonl"), "the meeting text");
  writeFileSync(conversationFile(layout), "c".repeat(32));
  chmodSync(join(layout.stateSnapshot, "locked"), 0o500);
  try {
    await expect(removeWorkingState(layout, { mountPoints: () => [] })).rejects.toThrow();
    expect(existsSync(conversationFile(layout))).toBe(true);
    expect(existsSync(join(layout.stateSnapshot, "locked", "session.jsonl"))).toBe(true);
  } finally {
    chmodSync(join(layout.stateSnapshot, "locked"), 0o700);
    rmSync(dir, { recursive: true, force: true });
  }
});
