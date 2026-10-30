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

export async function waitForScreenReady(page: Page, context: ScreenReadyContext, timeoutMs = 20_000): Promise<void> {
  try {
    await page.waitForFunction(() => (window as Window & { exoUi?: { ready: boolean } }).exoUi?.ready === true, undefined, {
      timeout: timeoutMs,
    });
  } catch (error) {
    const pageErrors = context.pageErrors.join("; ") || "no page errors";
    const requestUrls = context.inFlightRequestUrls();
    const inFlight = requestUrls.length ? requestUrls.join(", ") : "none";
    throw new Error(
      `${context.screenId} at ${context.viewportId}/${context.theme} never became ready: ${pageErrors}; in-flight requests: ${inFlight}`,
      { cause: error },
    );
  }
}
