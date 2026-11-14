// A module the feed needs soon but not to boot: it loads beside the app's startup chunk, not in it
// (frontend/scripts/entry-size-check.ts). The load starts when the importing module is evaluated, so it is there long
// before a card needs it; the hook gives it once it is.
import { useEffect, useState } from "react";

export function preloadModule<T>(load: () => Promise<T>): () => T | undefined {
  let loaded: T | undefined;
  const ready = load().then((module) => (loaded = module));
  return function useModule() {
    const [module, setModule] = useState(loaded);
    useEffect(() => { if (!module) void ready.then(setModule); }, [module]);
    return module;
  };
}
