import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { HistoryJournal } from "../history";
import { botLayout } from "../layout";
import { botIdFor } from "../owner";

test("journal listings retain the live completion ID, with a fallback for older records", () => {
  const root = mkdtempSync("/var/tmp/tc2909-journal-");
  try {
    const owner = "did:pkh:eip155:1:0x" + "11".repeat(20);
    const journal = new HistoryJournal(botLayout(botIdFor(owner), { dataRoot: join(root, "data"), runRoot: join(root, "run"), egressRoot: join(root, "egress") }),
      { signerDid: owner, host: "https://node.test", policy: "notice-then-expiry-30-days" });
    journal.begin(owner, 0);
    journal.append({ type: "user", text: "question" });
    journal.startDraft(); journal.delta("answer"); journal.finishDraft({ type: "done", messageId: "b-123" });
    journal.append({ type: "assistant", text: "older draft" });
    const messages = journal.messages();
    expect(messages[1]!.id).toBe("b-123");
    expect(messages[2]!.id).toMatch(/^history-[a-f0-9]{32}-3$/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
