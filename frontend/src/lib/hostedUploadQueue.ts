// The hosted backend keeps one unsent upload per account. Powerful notes and
// Upload audio must share this lane until their upload has been submitted.
const tails = new Map<string, Promise<void>>();

export async function withHostedUploadQueue<T>(did: string, work: () => Promise<T>): Promise<T> {
  const previous = tails.get(did) ?? Promise.resolve();
  let release!: () => void;
  const turn = new Promise<void>((resolve) => { release = resolve; });
  tails.set(did, turn);
  await previous;
  try {
    const locks = globalThis.navigator?.locks;
    return locks ? await locks.request(`exo-hosted-upload:${did}`, work) : await work();
  } finally {
    release();
    if (tails.get(did) === turn) tails.delete(did);
  }
}
