import { expect, test } from "bun:test";
import manifest from "../../../manifest.json";
import { ONE_APPS } from "./registry";

type Permission = { service: string; space?: string; path: string; actions: string[] };

// A native screen reads with One's own sign-in, not with a per-app grant, so what it lists in its ceiling is only true if the
// sign-in manifest already holds it. When the manifest narrows (for example the applications KV), this fails first.
test("every native app's read ceiling is covered by One's sign-in manifest", () => {
  const held = manifest.permissions as Permission[];
  const owner = { did: "did:pkh:eip155:1:0x00000000000000000000000000000000000000a1" } as never;
  for (const app of ONE_APPS) {
    if (app.kind !== "native" || !app.ceiling) continue;
    for (const { permission } of app.ceiling(owner)) {
      const covered = held.some((grant) =>
        grant.service === permission.service
        && grant.space === permission.space
        && permission.path.startsWith(grant.path)
        && permission.actions.every((action) => grant.actions.includes(action)));
      expect({ app: app.id, path: permission.path, covered }).toEqual({ app: app.id, path: permission.path, covered: true });
    }
  }
});
