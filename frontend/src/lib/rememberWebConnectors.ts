import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { getConnection } from "./connectors/connectorStore";
import { CONNECTORS } from "./connectors/registry";
import { readHomeFeatures, rememberHomeFeature, sessionCoversHomeFeature } from "./homeFeatures";

/** Recover device knowledge from an existing covering session, using only its connected-source records. */
export async function rememberExistingWebConnectors(
  store: Pick<Storage, "getItem" | "setItem"> | null,
  tcw: TinyCloudWeb,
  address: string,
): Promise<void> {
  if (!store || readHomeFeatures(store, address).includes("connectors") || !sessionCoversHomeFeature(tcw, "connectors", address)) return;
  try {
    for (const { id } of CONNECTORS) {
      const result = await getConnection(tcw, id);
      if (!result.ok) return;
      if (result.data?.status === "connected") {
        rememberHomeFeature(store, address, "connectors");
        return;
      }
    }
  } catch {
    // An unreadable record leaves the device flag unset. Opening Connectors can confirm use later.
  }
}
