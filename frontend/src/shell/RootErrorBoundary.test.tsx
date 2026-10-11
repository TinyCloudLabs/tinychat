import { expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, Children, isValidElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { Button } from "@/components/ui/button";
import { installDom } from "@/test/dom";
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

test("a real render error in any child of the root shows the recovery screen, not a blank root", async () => {
  const uninstall = installDom();
  const log = spyOn(console, "error").mockImplementation(() => {});
  const container = document.createElement("div");
  const root = createRoot(container);
  const Healthy = () => <p>app</p>;
  const Broken = () => { throw new Error("secretKeyFn is not a function"); };
  try {
    await act(async () => {
      root.render(<RootErrorBoundary><Healthy /><Broken /></RootErrorBoundary>);
    });
    expect(container.textContent).toContain("Exo hit a snag");
    expect(container.textContent).not.toContain("secretKeyFn");
    expect(container.querySelector("button")?.textContent).toBe("Reload");
  } finally {
    await act(async () => root.unmount());
    log.mockRestore();
    uninstall();
  }
});

test("main.tsx mounts the router and the PWA prompts inside the boundary", () => {
  const main = readFileSync(join(import.meta.dir, "../main.tsx"), "utf8");
  const boundary = main.slice(main.indexOf("<RootErrorBoundary>"), main.indexOf("</RootErrorBoundary>"));
  expect(boundary).toContain("<BrowserRouter>");
  expect(boundary).toContain("<PwaPrompts />");
});
