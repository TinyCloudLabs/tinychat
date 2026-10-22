// Browser build stand-in for `fs/promises`. @tinycloud/replica's profile-gate module imports it at
// top level for its file-backed (Node) gate store; the browser uses the IndexedDB gate in the same
// module and never calls these. vite-plugin-node-polyfills has no `fs/promises` shim, so without this
// the build fails to resolve it. Wired in vite.config.ts for the browser build only.
const unavailable = (name: string) => async (): Promise<never> => {
  throw new Error(`fs.${name} is not available in the browser`);
};

export const mkdir = unavailable("mkdir");
export const open = unavailable("open");
export const readFile = unavailable("readFile");
export const rename = unavailable("rename");
export const rm = unavailable("rm");
