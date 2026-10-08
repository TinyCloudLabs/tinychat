/** Small voice-note storage jobs and the existing background drain share this queue. */
let lane: Promise<unknown> = Promise.resolve();

export function runOnSpaceLane<T>(job: () => Promise<T>): Promise<T> {
  const result = lane.then(job);
  lane = result.then(() => undefined, () => undefined);
  return result;
}

/** Tests only: discard a completed lane from the previous case. */
export function resetSpaceLaneForTests(): void { lane = Promise.resolve(); }
