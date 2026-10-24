import { Fragment, useContext, useEffect, useState } from "react";
import { ServerIcon } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { SectionCard } from "@/components/ui/section-card";
import {
  clearNodeHost,
  clearNodePin,
  isLocalNodeHost,
  parseLoopbackNodeAddress,
  readNodePin,
  saveNodeHost,
  type NodeHostConfig,
} from "../lib/nodeHost";
import {
  NODE_CONFIRM_CANCEL,
  NODE_CONFIRM_CONFIRM,
  NODE_CONFIRM_TITLE,
  NODE_FORGET_BUTTON,
  NODE_FORGET_CANCEL,
  NODE_FORGET_CONFIRM,
  NODE_FORGET_TITLE,
  NODE_LIMITS_CLOSING,
  NODE_LIMITS_HEADING,
  NODE_LIMITS_INTRO,
  NODE_LIMITS_ITEMS,
  NODE_SETTING_FIELD_LABEL,
  NODE_SETTING_HELP,
  NODE_SETTING_CORS_HELP,
  NODE_SETTING_PLACEHOLDER,
  NODE_SETTING_SAVE,
  NODE_SETTING_SECTION_LABEL,
  NODE_SETTING_USE_DEFAULT,
  NODE_STATUS_DEFAULT,
  nodeConfirmBody,
  nodeConfirmCompare,
  nodeForgetNowLine,
  nodeForgetSavedLine,
  nodeForgetSignOutLine,
  nodeStatusLocal,
  nodeUnreachable,
  shortNodeId,
} from "../lib/nodeHostCopy";
import { fetchNodeId } from "../lib/nodePin";
import { PlatformContext } from "../lib/platform";
import { NODE_SETTINGS_HASH } from "./LocalNodeNotice";

/** Runs the change after the local session has been cleared, then reloads. False: the session could not be cleared and nothing changed. */
export type ApplyNodeChange = (apply: () => void) => Promise<boolean>;

/** The compare sentence with its backticked command shown as code. */
function WithCode({ text }: { text: string }) {
  return (
    <>
      {text.split("`").map((part, index) => (
        <Fragment key={index}>{index % 2 === 1 ? <code className="rounded bg-muted px-1 font-mono text-xs">{part}</code> : part}</Fragment>
      ))}
    </>
  );
}

/** "Your own node": the address the desktop app talks to. Desktop only; every string is final copy (nodeHostCopy.ts). */
export function NodeAddressSettings({ config, applyChange }: { config: NodeHostConfig; applyChange: ApplyNodeChange }) {
  const platform = useContext(PlatformContext);
  const address = config.hosts[0];
  const local = isLocalNodeHost(address);
  const [value, setValue] = useState(local ? address! : "");
  const [busy, setBusy] = useState(false);
  const [liveId, setLiveId] = useState<string | null>(null);
  const [probed, setProbed] = useState(false);
  const [forgetOpen, setForgetOpen] = useState(false);
  const [forgetCurrentId, setForgetCurrentId] = useState<string | null>(null);

  // Read live: the saved node ID is written after the page started, by the first sign-in.
  const pinnedId = local ? readNodePin(address!)?.nodeId : undefined;
  const shownId = pinnedId ?? liveId;
  useEffect(() => {
    if (platform !== "tauri" || !local || pinnedId) return;
    let cancelled = false;
    void fetchNodeId(address!).then((id) => {
      if (cancelled) return;
      setLiveId(id);
      setProbed(true);
    });
    return () => { cancelled = true; };
  }, [platform, local, address, pinnedId]);

  if (platform !== "tauri") return null;

  const parsed = parseLoopbackNodeAddress(value);
  const canSave = !busy && parsed !== null && parsed !== address;
  const change = async (apply: () => void) => {
    setBusy(true);
    const done = await applyChange(apply);
    if (!done) setBusy(false);
  };
  const openForget = () => {
    setForgetCurrentId(null);
    setForgetOpen(true);
    void fetchNodeId(address!).then(setForgetCurrentId);
  };

  return (
    <SectionCard id={NODE_SETTINGS_HASH.slice(1)} icon={ServerIcon} title={NODE_SETTING_SECTION_LABEL}>
      <p className="text-xs text-muted-foreground" data-node-status>
        {local
          ? shownId
            ? nodeStatusLocal(address!, shortNodeId(shownId))
            : probed ? nodeUnreachable(address!) : null
          : NODE_STATUS_DEFAULT}
      </p>
      <p className="mt-2 text-xs text-muted-foreground">{NODE_SETTING_HELP}</p>
      <label className="mt-3 flex flex-col gap-1 text-xs">
        <span className="font-medium">{NODE_SETTING_FIELD_LABEL}</span>
        <input
          type="text"
          inputMode="url"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          value={value}
          placeholder={NODE_SETTING_PLACEHOLDER}
          onChange={(event) => setValue(event.target.value)}
          disabled={busy}
          className="h-9 w-full rounded-md border border-input bg-background px-2 font-mono text-sm"
        />
      </label>
      <p className="mt-1 text-xs text-muted-foreground"><WithCode text={NODE_SETTING_CORS_HELP} /></p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" disabled={!canSave} onClick={() => void change(() => { saveNodeHost(value); })}>
          {NODE_SETTING_SAVE}
        </Button>
        <Button type="button" variant="outline" size="sm" disabled={busy || !local} onClick={() => void change(() => clearNodeHost())}>
          {NODE_SETTING_USE_DEFAULT}
        </Button>
        {local && pinnedId && (
          <Button type="button" variant="outline" size="sm" disabled={busy} onClick={openForget}>
            {NODE_FORGET_BUTTON}
          </Button>
        )}
      </div>
      <div className="mt-4 text-xs text-muted-foreground">
        <p className="font-medium text-foreground">{NODE_LIMITS_HEADING}</p>
        <p className="mt-1">{NODE_LIMITS_INTRO}</p>
        <ul className="mt-1 list-disc pl-5">
          {NODE_LIMITS_ITEMS.map((item) => <li key={item}>{item}</li>)}
        </ul>
        <p className="mt-1">{NODE_LIMITS_CLOSING}</p>
      </div>
      {local && pinnedId && (
        <AlertDialog open={forgetOpen} onOpenChange={setForgetOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{NODE_FORGET_TITLE}</AlertDialogTitle>
              <AlertDialogDescription>{nodeForgetSavedLine(pinnedId)}</AlertDialogDescription>
              {forgetCurrentId && <p className="text-sm text-muted-foreground">{nodeForgetNowLine(forgetCurrentId)}</p>}
              <p className="text-sm text-muted-foreground">{nodeForgetSignOutLine(address!)}</p>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{NODE_FORGET_CANCEL}</AlertDialogCancel>
              <AlertDialogAction onClick={() => void change(() => clearNodePin(address!))}>{NODE_FORGET_CONFIRM}</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </SectionCard>
  );
}

export interface NodeConfirmRequest {
  address: string;
  nodeId: string;
}

/** The one-time "Is this your node?" question before the first sign-in against a local node. */
export function NodeConfirmDialog({ request, onDecide }: { request: NodeConfirmRequest | null; onDecide: (confirmed: boolean) => void }) {
  return (
    <AlertDialog open={request !== null} onOpenChange={(open) => { if (!open) onDecide(false); }}>
      <AlertDialogContent>
        {request && (
          <>
            <AlertDialogHeader>
              <AlertDialogTitle>{NODE_CONFIRM_TITLE}</AlertDialogTitle>
              <AlertDialogDescription>{nodeConfirmBody(request.address)}</AlertDialogDescription>
              <p className="break-all font-mono text-sm" data-node-confirm-id>{request.nodeId}</p>
              <p className="text-sm text-muted-foreground"><WithCode text={nodeConfirmCompare(request.address)} /></p>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{NODE_CONFIRM_CANCEL}</AlertDialogCancel>
              <AlertDialogAction onClick={() => onDecide(true)}>{NODE_CONFIRM_CONFIRM}</AlertDialogAction>
            </AlertDialogFooter>
          </>
        )}
      </AlertDialogContent>
    </AlertDialog>
  );
}
