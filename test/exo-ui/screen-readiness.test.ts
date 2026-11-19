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
  const disposeTrackers: Array<() => void> = [];
  const pendingUrl = "https://screen-fixture.invalid/poll";
  try {
    const page = await browser.newPage();
    const held = await holdRequest(page, pendingUrl);
    releaseRequests.push(held.release);
    const requests = trackInFlightRequestUrls(page);
    disposeTrackers.push(requests.dispose);
    await page.setContent(`<script>
      window.exoUi = { ready: true, readyWhenMatched: true };
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
  } finally {
    for (const release of releaseRequests) release();
    for (const dispose of disposeTrackers) dispose();
    await browser.close();
  }
});

test("a ready timeout names the screen and its active request URLs", async () => {
  const browser = await chromium.launch({ headless: true });
  const releaseRequests: Array<() => void> = [];
  const disposeTrackers: Array<() => void> = [];
  const pendingUrl = "https://screen-fixture.invalid/stalled";
  try {
    const page = await browser.newPage();
    const held = await holdRequest(page, pendingUrl);
    releaseRequests.push(held.release);
    const requests = trackInFlightRequestUrls(page);
    disposeTrackers.push(requests.dispose);
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
  } finally {
    for (const release of releaseRequests) release();
    for (const dispose of disposeTrackers) dispose();
    await browser.close();
  }
});
test("a ready screen with unmatched readyWhen resolves false so the caller can record a cap hit", async () => {
  const browser = await chromium.launch({ headless: true });
  const releaseRequests: Array<() => void> = [];
  const disposeTrackers: Array<() => void> = [];
  const pendingUrl = "https://screen-fixture.invalid/ready-when-missing";
  try {
    const page = await browser.newPage();
    const held = await holdRequest(page, pendingUrl);
    releaseRequests.push(held.release);
    const requests = trackInFlightRequestUrls(page);
    disposeTrackers.push(requests.dispose);
    await page.setContent(`<script>
      window.exoUi = { ready: true, readyWhenMatched: false };
      fetch(${JSON.stringify(pendingUrl)}).catch(() => {});
    </script>`);
    await held.started;
    expect(await page.evaluate(() => (window as Window & { exoUi?: { ready: boolean; readyWhenMatched: boolean } }).exoUi))
      .toEqual({ ready: true, readyWhenMatched: false });

    await page.waitForFunction(
      () => (window as Window & { exoUi?: { ready: boolean } }).exoUi?.ready === true,
      undefined,
      { timeout: 1_000 },
    );
    expect(await waitForScreenReady(page, {
      screenId: "combine-confirm-pass",
      viewportId: "phone-land",
      theme: "dark",
      pageErrors: [],
      inFlightRequestUrls: requests.urls,
    }, 1_000)).toBe(false);
  } finally {
    for (const release of releaseRequests) release();
    for (const dispose of disposeTrackers) dispose();
    await browser.close();
  }
});
