import { createContext, useContext } from "react";
import { Link } from "react-router-dom";
import { NODE_DISABLED_LINE } from "../lib/nodeHostCopy";
import { PATHS } from "../shell/routes";

/**
 * True while the app's node address is a node on this computer (lib/nodeHost.ts: isLocalNodeHost on the
 * host read at startup). The controls that need Exo's online service read it and show the notice below
 * instead. App provides it once; the default is the hosted node.
 */
export const LocalNodeContext = createContext(false);

/** The Settings section where the node address is set and what does not work with it is listed. */
export const NODE_SETTINGS_HASH = "#node-address";

export function useLocalNode(): boolean {
  return useContext(LocalNodeContext);
}

/** The one line by a control that is off while the app uses a node on this computer. */
export function LocalNodeNotice({ className }: { className?: string }) {
  return (
    <p className={className ?? "text-xs text-muted-foreground"} data-local-node-notice>
      <Link to={`${PATHS.settings}${NODE_SETTINGS_HASH}`} className="underline underline-offset-2">{NODE_DISABLED_LINE}</Link>
    </p>
  );
}
