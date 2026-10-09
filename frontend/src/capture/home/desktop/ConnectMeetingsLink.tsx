import type { SessionStore } from "@tinyboilerplate/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";
import { ChevronRightIcon, PlugIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import * as connectorStore from "@/lib/connectors/connectorStore";
import { CONNECTORS } from "@/lib/connectors/registry";
import {
  MeetingSourcesDialog,
  SOURCE_IDS,
} from "../../meetingSources/MeetingSourcesDialog";
import { DESKTOP_HOME_COPY as COPY } from "./desktopCopy";

export type ConnectedRead =
  | { status: "loading" }
  | { status: "failed" }
  | { status: "ready"; connected: number };

/** How many of the meeting sources are connected, read again each time the window closes. */
export function useConnectedSources(
  tcw: TinyCloudWeb,
  open: boolean,
): ConnectedRead {
  const [read, setRead] = useState<ConnectedRead>({ status: "loading" });
  useEffect(() => {
    let active = true;
    void (async () => {
      let connected = 0;
      for (const id of SOURCE_IDS) {
        const descriptor = CONNECTORS.find((item) => item.id === id);
        if (!descriptor || descriptor.status !== "available") continue;
        const result = await connectorStore.getConnection(tcw, id);
        if (!result.ok) {
          console.error(
            "Meeting sources connection status failed",
            result.error,
          );
          if (active) setRead({ status: "failed" });
          return;
        }
        if (result.data?.status === "connected") connected += 1;
      }
      if (active) setRead({ status: "ready", connected });
    })();
    return () => {
      active = false;
    };
  }, [tcw, open]);
  return read;
}

export function connectMeetingsStatus(read: ConnectedRead): string | null {
  if (read.status === "failed") return COPY.connectUnavailable;
  if (read.status === "ready" && read.connected > 0)
    return COPY.connected(read.connected);
  return null;
}

export function ConnectMeetingsButton(props: {
  status: string | null;
  onClick: () => void;
  buttonRef?: React.Ref<HTMLButtonElement>;
}) {
  return (
    <button
      ref={props.buttonRef}
      type="button"
      className="dch-connect"
      onClick={props.onClick}
      data-testid="capture-connect-meetings"
    >
      <PlugIcon className="soft-ico" aria-hidden="true" />
      <span>
        {COPY.connect}
        {props.status !== null && <> · {props.status}</>}
      </span>
      <ChevronRightIcon className="soft-chev" aria-hidden="true" />
    </button>
  );
}

export function ConnectMeetingsLink(props: {
  tcw: TinyCloudWeb;
  backendUrl: string;
  sessionStore: SessionStore;
}) {
  const [open, setOpen] = useState(false);
  const entry = useRef<HTMLButtonElement>(null);
  const read = useConnectedSources(props.tcw, open);
  return (
    <>
      <ConnectMeetingsButton
        buttonRef={entry}
        status={connectMeetingsStatus(read)}
        onClick={() => setOpen(true)}
      />
      <MeetingSourcesDialog
        open={open}
        onOpenChange={setOpen}
        tcw={props.tcw}
        backendUrl={props.backendUrl}
        sessionStore={props.sessionStore}
        returnFocus={() => entry.current}
      />
    </>
  );
}
