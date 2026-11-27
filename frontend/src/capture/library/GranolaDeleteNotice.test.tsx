import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { installDom } from "@/test/dom";
import type { LibraryItem } from "./LibraryRow";
import { _resetConnectorSchemaMemoForTests } from "@/lib/connectors/connectorStore";
import { combineSpace, type SpaceRow } from "@/harness/fixtures/combineSpace";
import type { Library } from "./useLibrary";

mock.module("../../components/ui/responsive-sheet", () => ({
  ResponsiveSheet: (props: { open: boolean; title: ReactNode; children?: ReactNode; footer?: ReactNode; contentProps?: Record<string, string> }) =>
    props.open ? <div role="dialog" {...props.contentProps}><h2>{props.title}</h2>{props.children}{props.footer}</div> : null,
  ResponsiveSheetBody: (props: { children?: ReactNode }) => <div>{props.children}</div>,
  ResponsiveSheetFooter: (props: { children?: ReactNode }) => <div>{props.children}</div>,
}));
const { DeleteGranolaSheet, combinedLine } = await import("./DeleteGranolaSheet");
const { NoteDetail } = await import("./NoteDetail");

const row: LibraryItem = { id: "row", source: "granola", sourceId: "source", title: "Planning", startedAt: null, durationSecs: null };
const members = (...ids: string[]) => JSON.stringify({ merge: { members: ids.map((id) => ({ source: "granola", source_id: id })) } });
let root: Root;
let cleanup: () => void;
beforeEach(() => { cleanup = installDom(); });
afterEach(async () => { if (root) await act(async () => root.unmount()); cleanup(); });

// The fixture answers the Library statements; the Granola delete also asks for the schema and deletes by (source, source_id).
function granolaSpace(seed: SpaceRow[]) {
  _resetConnectorSchemaMemoForTests();
  const space = combineSpace(seed);
  const baseSql = space.tcw.sql;
  space.tcw = new Proxy(space.tcw, {
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
  return space;
}

async function open(space: ReturnType<typeof granolaSpace>, onGranolaDeleted: () => void) {
  const library = {
    note: { item: row, reads: { metadata: { status: "ok", metadata: {} }, transcript: { transcript: { status: "absent" } } }, audio: null },
    all: [row], items: [row], isCombinedMember: () => false,
    refresh: () => {}, status: "ready", listing: false, retry: () => {},
  } as unknown as Library;
  const node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
  await act(async () => root.render(<MemoryRouter><NoteDetail tcw={space.tcw} library={library} pushed={false} onBack={() => {}} onGranolaDeleted={onGranolaDeleted} transcription={undefined} /></MemoryRouter>));
  await act(async () => node.querySelector<HTMLButtonElement>('[data-testid="granola-delete"]')!.click());
  return node;
}

test("the sheet names how many combined meetings go with the meeting", () => {
  expect(combinedLine(1)).toBe("1 combined meeting that includes it will be deleted too.");
  expect(combinedLine(3)).toBe("3 combined meetings that include it will be deleted too.");
  expect(combinedLine(0)).toBeNull();
  expect(combinedLine(null)).toBe("Any combined meeting that includes it will be deleted too.");
});

test("the sheet says the delete cannot be undone and names the way to allow imports back", async () => {
  const node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
  await act(async () => root.render(<DeleteGranolaSheet open title="Planning" busy={false} error={null} combinedCount={0} onKeep={() => {}} onConfirm={() => {}} />));
  expect(node.textContent).toContain("It can’t be undone.");
  expect(node.textContent).toContain("unless you choose “Allow deleted meetings back”.");
  expect(node.querySelector('[data-testid="delete-granola-combined"]')).toBeNull();
});

test("a counted combined meeting is named, deleted with the meeting, and the notice fires once", async () => {
  const space = granolaSpace([
    { id: "row", source: "granola", sourceId: "source", title: "Planning", startedAt: null, durationSecs: null, body: "[]" },
    { id: "combo", source: "exo-merged", sourceId: "merged-1", title: "Combined", startedAt: null, durationSecs: null, metadata: members("source", "other") },
    { id: "other-combo", source: "exo-merged", sourceId: "merged-2", title: "Unrelated", startedAt: null, durationSecs: null, metadata: members("elsewhere", "other") },
  ]);
  let notices = 0;
  const node = await open(space, () => { notices++; });
  expect(node.querySelector('[data-testid="delete-granola-combined"]')?.textContent).toBe("1 combined meeting that includes it will be deleted too.");
  await act(async () => node.querySelector<HTMLButtonElement>('[data-testid="delete-granola-confirm"]')!.click());
  expect(space.rows.has("row")).toBe(false);
  expect(space.rows.has("combo")).toBe(false);
  expect(space.rows.has("other-combo")).toBe(true);
  expect(notices).toBe(1);
});

test("a failed delete shows Try again and gives no notice", async () => {
  const space = granolaSpace([{ id: "row", source: "granola", sourceId: "source", title: "Planning", startedAt: null, durationSecs: null, body: "[]" }]);
  let notices = 0;
  const node = await open(space, () => { notices++; });
  expect(node.querySelector('[data-testid="delete-granola-combined"]')).toBeNull();
  space.failNext.kv = "put";
  await act(async () => node.querySelector<HTMLButtonElement>('[data-testid="delete-granola-confirm"]')!.click());
  expect(node.querySelector('[data-testid="delete-granola-error"]')?.textContent).toBe("Couldn’t delete the meeting. Try again.");
  expect(space.rows.has("row")).toBe(true);
  expect(notices).toBe(0);
});
