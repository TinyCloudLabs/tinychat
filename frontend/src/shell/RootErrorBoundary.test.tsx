import { expect, spyOn, test } from "bun:test";
import { Children, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Button } from "@/components/ui/button";
import { RootErrorBoundary } from "./RootErrorBoundary";

function failedBoundary(onReload?: () => void) {
  const boundary = new RootErrorBoundary({ children: "app", onReload });
  boundary.state = RootErrorBoundary.getDerivedStateFromError();
  return boundary;
}

function findReload(node: ReactNode): (() => void) | undefined {
  if (!isValidElement<{ children?: ReactNode; onClick?: () => void }>(node)) return;
  if (node.type === Button && node.props.children === "Reload") return node.props.onClick;
  for (const child of Children.toArray(node.props.children)) {
    const action = findReload(child);
    if (action) return action;
  }
}

test("a healthy tree renders its children untouched", () => {
  expect(new RootErrorBoundary({ children: "app" }).render()).toBe("app");
});

test("a render error shows a calm recovery screen, not a blank root", () => {
  const surface = failedBoundary().render();
  const markup = renderToStaticMarkup(surface);
  expect(markup).toContain('role="alert"');
  expect(markup).toContain("Exo hit a snag");
  expect(markup).toContain(">Reload</button>");
  expect(markup).not.toContain("app");
});

test("Reload runs the reload action", () => {
  let reloads = 0;
  findReload(failedBoundary(() => { reloads++; }).render())?.();
  expect(reloads).toBe(1);
});

test("the error detail goes to the log, never the screen", () => {
  const log = spyOn(console, "error").mockImplementation(() => {});
  const boundary = failedBoundary();
  boundary.componentDidCatch(new Error("secretKeyFn is not a function"));
  expect(log).toHaveBeenCalledTimes(1);
  expect(renderToStaticMarkup(boundary.render())).not.toContain("secretKeyFn");
  log.mockRestore();
});
