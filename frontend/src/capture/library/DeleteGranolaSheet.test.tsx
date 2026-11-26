import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { installDom } from "@/test/dom";
import type { LibraryItem } from "./LibraryRow";
import { _resetConnectorSchemaMemoForTests, granolaDeletedKvKey, transcriptKvKey } from "@/lib/connectors/connectorStore";
import { combineSpace } from "@/harness/fixtures/combineSpace";
import type { Library } from "./useLibrary";

mock.module("../../components/ui/responsive-sheet", () => ({
  ResponsiveSheet: (props: { open: boolean; title: ReactNode; children?: ReactNode; footer?: ReactNode; contentProps?: Record<string, string> }) =>
    props.open ? <div role="dialog" {...props.contentProps}><h2>{props.title}</h2>{props.children}{props.footer}</div> : null,
  ResponsiveSheetBody: (props: { children?: ReactNode }) => <div>{props.children}</div>,
  ResponsiveSheetFooter: (props: { children?: ReactNode }) => <div>{props.children}</div>,
}));
// Load after the sheet mock so portal content is rendered in this DOM.
const { NoteDetailView } = await import("./NoteDetailView");
const { DeleteGranolaSheet } = await import("./DeleteGranolaSheet");
const { NoteDetail } = await import("./NoteDetail");
const row: LibraryItem = { id: "row", source: "granola", sourceId: "source", title: "Planning", startedAt: null, durationSecs: null };
let root: Root;
let cleanup: () => void;
const host = () => { const node = document.createElement("div"); document.body.append(node); root = createRoot(node); return node; };
const render = async (item: LibraryItem, onDelete?: () => void) => {
  const node = host();
  await act(async () => root.render(<MemoryRouter><NoteDetailView item={item} listStatus="ready" metadata={{ status: "ok", metadata: {} }} transcript={{ status: "absent" }} audio={null} copyState="idle" onCopy={() => {}} onRetry={() => {}} pushed={false} onBack={() => {}} onDeleteGranola={onDelete} /></MemoryRouter>));
  return node;
};
beforeEach(() => { cleanup = installDom(); });
afterEach(async () => { if (root) await act(async () => root.unmount()); cleanup(); });

test("delete action is offered only on a Granola row", async () => {
  const node = await render(row, () => {});
  expect(node.querySelector('[data-testid="granola-delete"]')).not.toBeNull();
  await act(async () => root.render(<MemoryRouter><NoteDetailView item={{ ...row, source: "exo-merged" }} listStatus="ready" metadata={{ status: "ok", metadata: {} }} transcript={{ status: "absent" }} audio={null} copyState="idle" onCopy={() => {}} onRetry={() => {}} pushed={false} onBack={() => {}} onDeleteGranola={() => {}} /></MemoryRouter>));
  expect(node.querySelector('[data-testid="granola-delete"]')).toBeNull();
});

test("confirmation keeps the safe action first and shows a write error", async () => {
  const node = host();
  const calls: string[] = [];
  await act(async () => root.render(<DeleteGranolaSheet open title="Planning" busy={false} error="Couldn’t delete the meeting." onKeep={() => calls.push("keep")} onConfirm={() => calls.push("delete")} />));
  const buttons = [...node.querySelectorAll("button")];
  expect(buttons[0]?.textContent).toContain("Keep it");
  expect(node.textContent).toContain("Couldn’t delete the meeting.");
  await act(async () => buttons[1]?.click());
  expect(calls).toEqual(["delete"]);
});

test("confirm removes the Granola row and transcript; a failed write keeps the sheet open", async () => {
  _resetConnectorSchemaMemoForTests();
  const space = combineSpace([{ id: "row", source: "granola", sourceId: "source", title: "Planning", startedAt: null, durationSecs: null, body: "[]" }]);
  const baseSql = space.tcw.sql;
  const baseTcw = space.tcw;
  space.tcw = new Proxy(baseTcw, {
    get(target, key) {
      if (key !== "sql") return Reflect.get(target, key);
      return { db: (name: string) => {
        const db = baseSql.db(name);
        return {
          query: (sql: string, params?: unknown[]) => sql.includes("sqlite_master")
            ? Promise.resolve({ ok: true, data: { rows: [["connector_meeting"], ["connector_state"]] } })
            : db.query(sql, params),
          execute: (sql: string, params?: unknown[]) => {
            if (sql === "DELETE FROM connector_meeting WHERE source = ? AND source_id = ?") {
              for (const [id, entry] of space.rows) if (entry.source === params?.[0] && entry.sourceId === params?.[1]) space.rows.delete(id);
              return Promise.resolve({ ok: true, data: { rows: [] } });
            }
            return db.execute(sql, params);
          },
        };
      } };
    },
  });
  let refreshed = 0;
  let backed = 0;
  const library = {
    note: { item: row, reads: { metadata: { status: "ok", metadata: {} }, transcript: { transcript: { status: "absent" } } }, audio: null },
    all: [row], items: [row], isCombinedMember: () => false,
    refresh: () => { refreshed++; }, status: "ready", listing: false, retry: () => {},
  } as unknown as Library;
  const node = host();
  await act(async () => root.render(<MemoryRouter><NoteDetail tcw={space.tcw} library={library} pushed={false} onBack={() => { backed++; }} transcription={undefined} /></MemoryRouter>));
  await act(async () => node.querySelector<HTMLButtonElement>('[data-testid="granola-delete"]')!.click());
  expect(node.querySelector('[data-testid="delete-granola-sheet"]')).not.toBeNull();
  space.failNext.kv = "put";
  await act(async () => node.querySelector<HTMLButtonElement>('[data-testid="delete-granola-confirm"]')!.click());
  expect(node.querySelector('[data-testid="delete-granola-error"]')).not.toBeNull();
  expect(space.rows.has("row")).toBe(true);
  await act(async () => node.querySelector<HTMLButtonElement>('[data-testid="delete-granola-confirm"]')!.click());
  expect(space.rows.has("row")).toBe(false);
  expect(space.kv.has(transcriptKvKey("granola", "source"))).toBe(false);
  expect(space.kv.has(granolaDeletedKvKey("source"))).toBe(true);
  expect(refreshed).toBe(1);
  expect(backed).toBe(1);
});
