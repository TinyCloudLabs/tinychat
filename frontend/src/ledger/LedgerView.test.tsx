import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { LedgerView } from "./LedgerView";
import type { LedgerRow } from "./model";

const row: LedgerRow = {
  id: "a/task", title: '<img src=x onerror="alert(1)">', stage: "Building", stageSince: "2026-11-23T12:00:00Z",
  agentLabel: "Writer · a", condition: "Blocked: review", note: "https://example.test/proof", blockedBy: 2, blocks: 3,
};
test("renders task content as text, without links or agent-authored markup", () => {
  const html = renderToStaticMarkup(<LedgerView rows={[row]} now={Date.parse("2026-11-23T14:00:00Z")} state="ready" onRefresh={() => {}} />);
  expect(html).toContain("&lt;img");
  expect(html).not.toContain("<img");
  expect(html).not.toContain("<a ");
  expect(html).toContain("2h");
  expect(html).toContain("blocked by 2 · blocks 3");
});
test("empty state is only shown after a successful load", () => {
  const render = (state: "loading" | "failed" | "ready") => renderToStaticMarkup(<LedgerView rows={[]} now={0} state={state} onRefresh={() => {}} />);
  expect(render("ready")).toContain("No tasks to show. When an agent you&#x27;ve connected records a task, it shows here.");
  expect(render("loading")).not.toContain("No tasks to show.");
  expect(render("failed")).not.toContain("No tasks to show.");
});
test("labels independent check evidence with the checker identity", () => {
  const checked = { ...row, stage: "Checked" as const, checkedBy: "Review agent · abcd1234", evidence: "All saved notes reviewed." };
  const html = renderToStaticMarkup(<LedgerView rows={[checked]} now={Date.parse("2026-11-23T14:00:00Z")} state="ready" onRefresh={() => {}} />);
  expect(html).toContain("Checked by Review agent · abcd1234: All saved notes reviewed.");
});
