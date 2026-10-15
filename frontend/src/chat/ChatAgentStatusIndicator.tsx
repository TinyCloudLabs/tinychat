import { Link, useLocation } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { agentAccessStatusLabel, useAgentAccess, type UseAgentEnablementResult } from "./useAgentEnablement";
import { isChatViewPath } from "./chatViewPath";

export function ChatAgentStatusIndicator(props: UseAgentEnablementResult) {
  const connected = props.capability === "enabled";
  const canConnect = props.capability === "available";
  const statusLabel = agentAccessStatusLabel(props);

  return (
    <div
      aria-live="polite"
      aria-atomic="true"
      className="flex min-h-11 items-center justify-between gap-3 border-b border-border/70 bg-background px-3 text-xs sm:px-4"
    >
      <span role="status" className="flex min-w-0 items-center gap-2 font-medium text-foreground">
        <span
          aria-hidden="true"
          className={`size-2 shrink-0 rounded-full ${connected ? "bg-green-500" : props.capability === "unavailable" ? "bg-destructive" : "bg-muted-foreground"}`}
        />
        <span className="truncate">Agent access: {statusLabel}</span>
      </span>
      {canConnect ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => void props.onEnable()}
          disabled={props.enabling || props.disconnecting}
          className="shrink-0"
        >
          {props.enabling ? "Connecting…" : props.reconnectReason ? "Reconnect agent" : "Connect agent"}
        </Button>
      ) : (
        <Button asChild size="sm" variant="link" className="shrink-0">
          <Link to="/chat/settings#agent-access">Settings</Link>
        </Button>
      )}
    </div>
  );
}

export function ChatViewAgentStatusIndicator() {
  const { pathname } = useLocation();
  const props = useAgentAccess();
  if (!isChatViewPath(pathname)) return null;
  return <ChatAgentStatusIndicator {...props} />;
}
