export interface Autosave {
  /** Saves `value` after the delay; a newer value replaces it. */
  schedule(value: string): void;
  /** Saves a waiting value now. */
  flush(): void;
  readonly pending: boolean;
}

export function createAutosave(
  save: (value: string) => void,
  delayMs: number,
  onPending: (pending: boolean) => void = () => {},
): Autosave {
  let waiting: { value: string } | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = () => {
    clearTimeout(timer);
    if (!waiting) return;
    const { value } = waiting;
    waiting = null;
    save(value);
    onPending(false);
  };
  return {
    schedule(value) {
      waiting = { value };
      onPending(true);
      clearTimeout(timer);
      timer = setTimeout(run, delayMs);
    },
    flush: run,
    get pending() {
      return waiting !== null;
    },
  };
}
