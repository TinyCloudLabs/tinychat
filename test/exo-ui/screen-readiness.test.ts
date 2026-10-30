import { expect, test } from "bun:test";
import { chromium, type Page } from "playwright";

import { trackInFlightRequestUrls, waitForScreenReady } from "./screen-readiness";

async function holdRequest(page: Page, url: string) {
  const release = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  await page.route(url, async (route) => {
    started.resolve();
    await release.promise;
    await route.abort().catch(() => {});
  });
  return { started: started.promise, release: () => release.resolve() };
}

test("a ready screen can be captured while an unrelated request remains in flight", async () => {
  const browser = await chromium.launch({ headless: true });
  const releaseRequests: Array<() => void> = [];
  const pendingUrl = "https://screen-fixture.invalid/poll";
  try {
    const page = await browser.newPage();
    const held = await holdRequest(page, pendingUrl);
    releaseRequests.push(held.release);
    const requests = trackInFlightRequestUrls(page);
    await page.setContent(`<script>
      window.exoUi = { ready: true };
      fetch(${JSON.stringify(pendingUrl)}).catch(() => {});
    </script>`);
    await held.started;

    await waitForScreenReady(page, {
      screenId: "combine-confirm-pass",
      viewportId: "phone-land",
      theme: "dark",
      pageErrors: [],
      inFlightRequestUrls: requests.urls,
    });
    expect(requests.urls()).toEqual([pendingUrl]);
    requests.dispose();
  } finally {
    for (const release of releaseRequests) release();
    await browser.close();
  }
});

test("a ready timeout names the screen and its active request URLs", async () => {
  const browser = await chromium.launch({ headless: true });
  const releaseRequests: Array<() => void> = [];
  const pendingUrl = "https://screen-fixture.invalid/stalled";
  try {
    const page = await browser.newPage();
    const held = await holdRequest(page, pendingUrl);
    releaseRequests.push(held.release);
    const requests = trackInFlightRequestUrls(page);
    await page.setContent(`<script>
      window.exoUi = { ready: false };
      fetch(${JSON.stringify(pendingUrl)}).catch(() => {});
    </script>`);
    await held.started;

    // A genuine short Playwright timeout is needed to exercise the timeout diagnostic.
    await expect(waitForScreenReady(page, {
      screenId: "combine-confirm-pass-web",
      viewportId: "phone-land",
      theme: "light",
      pageErrors: [],
      inFlightRequestUrls: requests.urls,
    }, 1)).rejects.toThrow(/combine-confirm-pass-web at phone-land\/light.*screen-fixture\.invalid\/stalled/);
    requests.dispose();
  } finally {
    for (const release of releaseRequests) release();
    await browser.close();
  }
});
