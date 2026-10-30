import type { Page, Request } from "playwright";

export interface ScreenReadyContext {
  screenId: string;
  viewportId: string;
  theme: string;
  pageErrors: readonly string[];
  inFlightRequestUrls: () => string[];
}

export function trackInFlightRequestUrls(page: Page) {
  const requests = new Map<Request, string>();
  const onRequest = (request: Request) => requests.set(request, request.url());
  const onDone = (request: Request) => requests.delete(request);
  page.on("request", onRequest);
  page.on("requestfinished", onDone);
  page.on("requestfailed", onDone);

  return {
    urls: () => [...new Set(requests.values())].sort(),
    dispose: () => {
      page.off("request", onRequest);
      page.off("requestfinished", onDone);
      page.off("requestfailed", onDone);
    },
  };
}

function screenReadinessError(context: ScreenReadyContext, reason: string, cause: unknown): Error {
  const pageErrors = context.pageErrors.join("; ") || "no page errors";
  const requestUrls = context.inFlightRequestUrls();
  const inFlight = requestUrls.length ? requestUrls.join(", ") : "none";
  return new Error(
    `${context.screenId} at ${context.viewportId}/${context.theme} ${reason}: ${pageErrors}; in-flight requests: ${inFlight}`,
    { cause },
  );
}

export async function waitForScreenReady(page: Page, context: ScreenReadyContext, timeoutMs = 20_000): Promise<void> {
  let state: string;
  try {
    const ready = await page.waitForFunction(() => {
      const exoUi = (window as Window & { exoUi?: { ready: boolean; readyWhenMatched?: boolean } }).exoUi;
      if (!exoUi?.ready) return false;
      return exoUi.readyWhenMatched === true ? "ready" : "readyWhen-unmatched";
    }, undefined, { timeout: timeoutMs });
    state = await ready.jsonValue();
  } catch (error) {
    throw screenReadinessError(context, "never became ready", error);
  }
  if (state !== "ready") {
    throw screenReadinessError(
      context,
      "readyWhen did not match before the harness readiness cap",
      new Error("The harness marked the screen ready after its readyWhen cap."),
    );
  }
}
