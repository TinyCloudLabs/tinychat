import { describe, expect, test } from "bun:test";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createUnwiredExoPorts } from "../exo/default-ports.js";
import { EXO_WAKE_INTAKE_LIMIT_PER_MIN, FixedWindowBudget, WakeQueue } from "../exo/wake-intake.js";
import { createExoMailboxRouter, type ExoWakeOptions } from "../routes/exo-mailbox.js";

const OWNER = `0x${"b".repeat(40)}`;
const OWNER_DID = `did:pkh:eip155:1:${OWNER}`;
const T0 = Date.UTC(2026, 0, 1, 12);

/** Counts what reaches the queue: only those wakes can cost grant and node reads. */
class CountingQueue extends WakeQueue {
  offered = 0;
  override offer(owner: string, requestId: string, run: () => Promise<void>): void {
    this.offered++;
    super.offer(owner, requestId, run);
  }
}

async function withRoute<T>(
  options: ExoWakeOptions,
  held: (owner: string) => boolean,
  run: (base: string) => Promise<T>,
  now: () => number = () => T0,
): Promise<T> {
  const app = express();
  app.use(
    "/api/exo/v1",
    createExoMailboxRouter(
      { ...createUnwiredExoPorts(), now },
      { mayHold: held, refreshIfStale: () => {} },
      options,
    ),
  );
  const listening = Promise.withResolvers<Server>();
  const server = app.listen(0, "127.0.0.1", () => listening.resolve(server));
  const bound = await listening.promise;
  try {
    return await run(`http://127.0.0.1:${(bound.address() as AddressInfo).port}`);
  } finally {
    const closed = Promise.withResolvers<void>();
    bound.closeAllConnections();
    bound.close(() => closed.resolve());
    await closed.promise;
  }
}

const wake = (base: string, owner = OWNER_DID, requestId: string = crypto.randomUUID()) =>
  fetch(`${base}/api/exo/v1/requests`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ owner, requestId }),
  });

describe("Exo wake intake budget", () => {
  test("a wake for a held owner past the budget gets the same 202 and never reaches the queue", async () => {
    const queue = new CountingQueue();
    await withRoute({ queue, intakeBudget: new FixedWindowBudget(2, 60_000) }, () => true, async (base) => {
      const answers = [];
      for (let i = 0; i < 4; i++) {
        const response = await wake(base);
        answers.push({ status: response.status, body: await response.json() });
      }
      expect(answers).toEqual(Array(4).fill({ status: 202, body: { status: "accepted" } }));
      expect(queue.offered).toBe(2);
    });
  });

  test("wakes for owners the index does not hold do not spend the budget", async () => {
    const queue = new CountingQueue();
    await withRoute({ queue, intakeBudget: new FixedWindowBudget(1, 60_000) }, (owner) => owner === OWNER, async (base) => {
      for (let i = 0; i < 20; i++) {
        expect((await wake(base, `did:pkh:eip155:1:0x${"c".repeat(40)}`)).status).toBe(202);
      }
      expect(queue.offered).toBe(0);
      expect((await wake(base)).status).toBe(202);
      expect(queue.offered).toBe(1);
    });
  });

  test("the budget refills when its window ends", async () => {
    const queue = new CountingQueue();
    let at = T0;
    await withRoute(
      { queue, intakeBudget: new FixedWindowBudget(1, 60_000) },
      () => true,
      async (base) => {
        await wake(base);
        await wake(base);
        expect(queue.offered).toBe(1);
        at += 60_000;
        await wake(base);
        expect(queue.offered).toBe(2);
      },
      () => at,
    );
  });

  test("the router built the way production builds it queues no more than the intake limit in one window", async () => {
    const queue = new CountingQueue();
    await withRoute({ queue }, () => true, async (base) => {
      for (let i = 0; i < EXO_WAKE_INTAKE_LIMIT_PER_MIN + 10; i++) {
        expect((await wake(base)).status).toBe(202);
      }
      expect(queue.offered).toBe(EXO_WAKE_INTAKE_LIMIT_PER_MIN);
    });
  });
});
