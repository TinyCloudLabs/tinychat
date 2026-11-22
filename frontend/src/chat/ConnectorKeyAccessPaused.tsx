// A connector paused because a background read found its key needs the owner's approval (TC-3804). The row says
// so and offers "Approve in OpenKey"; this click is the only place a paused connector asks OpenKey.
import { useState, useSyncExternalStore, type ReactNode } from "react";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import {
  APPROVE_IN_OPENKEY,
  askConnectorKeyAccess,
  connectorKeyAccessVersion,
  connectorPausedMessage,
  isConnectorKeyAccessPaused,
  onConnectorKeyAccessChange,
} from "@/lib/connectors/connectorKeyAccess";
import type { ConnectorDescriptor } from "@/lib/connectors/types";

export function ConnectorKeyAccessPaused({
  tcw,
  descriptor: d,
  onApproved,
  className,
  textClassName,
  buttonClassName,
  renderButton,
}: {
  tcw: TinyCloudWeb;
  descriptor: ConnectorDescriptor;
  /** Runs once the owner approved, e.g. the row's Sync now. */
  onApproved: () => void;
  className?: string;
  textClassName?: string;
  buttonClassName?: string;
  /** The surface's own button; defaults to a plain <button>. */
  renderButton?: (props: { onClick: () => void; disabled: boolean; label: string }) => ReactNode;
}) {
  useSyncExternalStore(onConnectorKeyAccessChange, connectorKeyAccessVersion, connectorKeyAccessVersion);
  const [asking, setAsking] = useState(false);
  const owner = tcw.session()?.address ?? null;
  if (!owner || !isConnectorKeyAccessPaused(owner, d.id)) return null;

  const approve = () => {
    if (asking) return;
    setAsking(true);
    void askConnectorKeyAccess(tcw, [d])
      .then((result) => {
        if (result === "granted") onApproved();
      })
      .catch((cause: unknown) => console.error(`OpenKey approval for ${d.id} failed`, cause))
      .finally(() => setAsking(false));
  };

  return (
    <div className={className} data-testid="connector-key-access-paused">
      <p role="status" className={textClassName}>
        {connectorPausedMessage(owner, d)}
      </p>
      {renderButton ? (
        renderButton({ onClick: approve, disabled: asking, label: APPROVE_IN_OPENKEY })
      ) : (
        <button type="button" className={buttonClassName} aria-disabled={asking} onClick={approve}>
          {APPROVE_IN_OPENKEY}
        </button>
      )}
    </div>
  );
}
