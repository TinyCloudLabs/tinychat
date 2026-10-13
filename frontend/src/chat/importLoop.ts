import { isStorageFullError } from "../lib/storageStatus";

export interface ImportLoopFailure<T> {
  item: T;
  error: unknown;
}

export interface ImportLoopResult<T> {
  imported: number;
  canceled: number;
  failures: ImportLoopFailure<T>[];
}

/** Import in order and stop rather than retrying later rows after storage fills. */
export async function runImportLoop<T>(
  items: readonly T[],
  importItem: (item: T) => Promise<void>,
  isCanceled: () => boolean,
  onProgress: () => void,
): Promise<ImportLoopResult<T>> {
  let imported = 0;
  let canceled = 0;
  const failures: ImportLoopFailure<T>[] = [];

  for (let i = 0; i < items.length; i++) {
    if (isCanceled()) {
      canceled++;
      onProgress();
      continue;
    }
    const item = items[i]!;
    try {
      await importItem(item);
      imported++;
    } catch (error) {
      failures.push({ item, error });
      if (isStorageFullError(error)) {
        canceled += items.length - i - 1;
        for (let remaining = items.length - i; remaining > 0; remaining--) onProgress();
        break;
      }
    }
    onProgress();
  }

  return { imported, canceled, failures };
}
