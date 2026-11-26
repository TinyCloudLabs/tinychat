import { expect, mock, test } from "bun:test";
import { type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

mock.module("../../components/ui/responsive-sheet", () => ({
  ResponsiveSheet: (props: { open: boolean; children?: ReactNode; footer?: ReactNode }) =>
    props.open ? <div>{props.children}{props.footer}</div> : null,
  ResponsiveSheetBody: (props: { children?: ReactNode }) => <div>{props.children}</div>,
}));
// The sheet module must load after the portal mock so server rendering sees its contents.
const { DeleteGranolaSheet } = await import("./DeleteGranolaSheet");

test("Fireflies deletion explains its source-specific reimport rule and combined deletion", () => {
  const html = renderToStaticMarkup(<DeleteGranolaSheet open title="Planning" busy={false} error={null} combinedCount={2} source="fireflies" onKeep={() => {}} onConfirm={() => {}} />);
  expect(html).toContain("2 combined meetings that include it will be deleted too.");
  expect(html).toContain("It can’t be undone.");
  expect(html).toContain("Syncing Fireflies won’t bring it back");
  expect(html).not.toContain("Granola");
});

test("Meet deletion explains its source-specific reimport rule", () => {
  const html = renderToStaticMarkup(<DeleteGranolaSheet open title="Planning" busy={false} error={null} combinedCount={0} source="google-meet" onKeep={() => {}} onConfirm={() => {}} />);
  expect(html).toContain("Syncing Google Meet won’t bring it back");
  expect(html).not.toContain("Granola");
});
