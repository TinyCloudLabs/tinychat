import type { PrivateKeyAccount } from "viem/accounts";

type Permission = { service: string; space: string; path: string; actions: string[] };

/** What OpenKey reports back as approved, read from the SIWE's recap: the action keys and the permission list. */
export function approvedFromSiwe(siwe: string): { selectedActionKeys: string[]; permissions: Permission[] } {
  const recap = /urn:recap:([A-Za-z0-9_-]+)/.exec(siwe)?.[1];
  if (!recap) return { selectedActionKeys: [], permissions: [] };
  const att = (JSON.parse(Buffer.from(recap, "base64url").toString("utf8")) as { att: Record<string, Record<string, unknown>> }).att;
  const keys: string[] = [];
  const permissions = new Map<string, Permission>();
  for (const [resource, abilities] of Object.entries(att)) {
    // A resource is `<space>/<service dir>/<path>`; an encryption network (`urn:tinycloud:encryption:…`) has no path.
    const slash = resource.indexOf("/");
    const space = slash === -1 ? resource : resource.slice(0, slash);
    const rest = slash === -1 ? "" : resource.slice(slash + 1);
    const path = rest.includes("/") ? rest.slice(rest.indexOf("/") + 1) : "";
    for (const ability of Object.keys(abilities)) {
      const service = ability.slice(0, ability.indexOf("/"));
      // The capabilities read is implicit: listed as a permission, never as a selectable action.
      if (ability !== "tinycloud.capabilities/read") keys.push([service, space, path, ability].join("\0"));
      const id = [service, space, path].join("\0");
      const entry = permissions.get(id) ?? { service, space, path, actions: [] };
      entry.actions.push(ability);
      permissions.set(id, entry);
    }
  }
  return { selectedActionKeys: keys, permissions: [...permissions.values()] };
}

/**
 * The SIWE with the capabilities `keep` refuses removed from its recap, as OpenKey signs it when the owner unticks
 * permissions in the review.
 */
export function narrowSiwe(siwe: string, keep: (resource: string, ability: string) => boolean): string {
  const match = /urn:recap:([A-Za-z0-9_-]+)/.exec(siwe);
  if (!match) return siwe;
  const recap = JSON.parse(Buffer.from(match[1]!, "base64url").toString("utf8")) as { att: Record<string, Record<string, unknown>> };
  const att: Record<string, Record<string, unknown>> = {};
  for (const [resource, abilities] of Object.entries(recap.att)) {
    const kept = Object.fromEntries(Object.entries(abilities).filter(([ability]) => keep(resource, ability)));
    if (Object.keys(kept).length > 0) att[resource] = kept;
  }
  // The statement lists the same capabilities in words, and the SDK checks it against the recap.
  const actions = Object.entries(att).map(([resource, abilities], index) => {
    const named = Object.keys(abilities).map((ability) => `'${ability.slice(ability.indexOf("/") + 1)}'`);
    const namespace = Object.keys(abilities)[0]!.slice(0, Object.keys(abilities)[0]!.indexOf("/"));
    return `(${index + 1}) '${namespace}': ${named.join(", ")} for '${resource}'.`;
  });
  return siwe
    .replace(/(I further authorize the stated URI to perform the following actions on my behalf:).*/, `$1 ${actions.join(" ")}`)
    .replace(match[0], `urn:recap:${Buffer.from(JSON.stringify({ ...recap, att }), "utf8").toString("base64url")}`);
}

/**
 * OpenKey's versioned authorization (`authorizeTinyCloud`) as the SDK can tell it: the stub signs the SIWE it is shown
 * with `account` and reports what was approved, or the owner closes it (`"decline"`). `record` sees each request.
 */
export function openKeyStub(
  account: PrivateKeyAccount,
  answer: "approve" | "decline" = "approve",
  record?: (request: { siwe: string; host?: string }, options?: { mode?: string }) => void,
  /** The owner unticked what this refuses: OpenKey signs the narrowed SIWE instead of the requested one. */
  keep?: (resource: string, ability: string) => boolean,
) {
  return {
    async authorizeTinyCloud(request: { siwe: string; host?: string }, options?: { mode?: string }) {
      record?.(request, options);
      if (answer === "decline") throw { code: "USER_CANCELLED" };
      const signed = keep ? narrowSiwe(request.siwe, keep) : request.siwe;
      return {
        protocolVersion: 1 as const,
        address: account.address,
        signature: await account.signMessage({ message: signed }),
        signedMessage: signed,
        ...approvedFromSiwe(signed),
      };
    },
  };
}
