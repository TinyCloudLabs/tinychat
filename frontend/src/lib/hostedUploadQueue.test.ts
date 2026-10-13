import { expect, test } from "bun:test";
import { withHostedUploadQueue } from "./hostedUploadQueue";

test("hosted uploads for one account wait for submission while another account can proceed", async () => {
  const events: string[] = [];
  let finishFirst!: () => void;
  const first = withHostedUploadQueue("account-a", async () => {
    events.push("first-start");
    await new Promise<void>((resolve) => { finishFirst = resolve; });
    events.push("first-submitted");
  });
  const second = withHostedUploadQueue("account-a", async () => { events.push("second-start"); });
  const other = withHostedUploadQueue("account-b", async () => { events.push("other-start"); });
  await other;
  expect(events).toEqual(["first-start", "other-start"]);
  finishFirst();
  await Promise.all([first, second]);
  expect(events).toEqual(["first-start", "other-start", "first-submitted", "second-start"]);

  await withHostedUploadQueue("account-a", async () => { events.push("third-start"); });
  expect(events.at(-1)).toBe("third-start");
});

test("a failed hosted upload releases the next account turn", async () => {
  const events: string[] = [];
  const failed = withHostedUploadQueue("account-failure", async () => { throw new Error("upload failed"); });
  const next = withHostedUploadQueue("account-failure", async () => { events.push("next-start"); });
  await expect(failed).rejects.toThrow("upload failed");
  await next;
  expect(events).toEqual(["next-start"]);
});
