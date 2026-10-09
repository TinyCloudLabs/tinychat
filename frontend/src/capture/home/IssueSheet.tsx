// The small sheet a failed Recent row opens (TC-871): what went wrong, in a
// sentence, and Close. A recording that could not be recovered also gets Try
// again and Delete (TC-868); Delete asks first. A saved recording that is
// missing some audio gets an informational sheet instead: what is missing (when
// the recorder knows) and Dismiss. A labelled modal dialog; closing returns
// focus to the control that opened it.
import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useId, useRef, useState, type RefObject } from "react";

import {
  dismissNotice,
  issueCanRetry,
  issueIsInformational,
  issueIsRecoverable,
  issueSheetCopy,
  partialAudioMissingLine,
  type HomeIssue,
} from "./captureIssues";
import {
  useFailedActions,
  type FailedActions,
} from "./failedActions";
import { HOME_COPY } from "./homeCopy";
import { useSoftTheme } from "./softTheme";
import { SheetDialog } from "../recorder/final/SheetDialog";
import "../recorder/final/phone.css";

const SAME = (text: string) => text;

function Actions(props: {
  actions: FailedActions;
  text: (text: string) => string;
  canRetry: boolean;
  deleteRef: RefObject<HTMLButtonElement | null>;
}) {
  const { actions } = props;
  const busy = actions.busy !== null;
  return (
    <div className="soft-sheet-actions" data-busy={busy ? "true" : undefined}>
      {actions.error !== null && (
        <p role="alert" className="soft-sheet-error" data-testid="capture-issue-error">
          {props.text(actions.error)}
        </p>
      )}
      {/* aria-disabled, not disabled: a busy button keeps focus. */}
      {props.canRetry && (
        <button
          type="button"
          className="soft-sheet-close"
          aria-disabled={busy}
          onClick={() => !busy && actions.tryAgain()}
          data-testid="capture-issue-retry"
        >
          {actions.busy === "retry" ? HOME_COPY.tryingAgain : HOME_COPY.tryAgain}
        </button>
      )}
      <button
        ref={props.deleteRef}
        type="button"
        className="soft-sheet-delete"
        aria-disabled={busy}
        onClick={() => !busy && actions.askDelete()}
        data-testid="capture-issue-delete"
      >
        {actions.busy === "delete" ? HOME_COPY.deleting : HOME_COPY.delete}
      </button>
    </div>
  );
}

function Notice(props: {
  error: string | null;
  onDismiss: () => void;
  closeRef: RefObject<HTMLButtonElement | null>;
}) {
  return (
    <div className="soft-sheet-actions">
      {props.error !== null && (
        <p role="alert" className="soft-sheet-error" data-testid="capture-issue-error">
          {props.error}
        </p>
      )}
      <Dialog.Close
        ref={props.closeRef}
        className="soft-sheet-close"
        data-testid="capture-issue-close"
      >
        {HOME_COPY.close}
      </Dialog.Close>
      <button
        type="button"
        className="soft-sheet-quiet"
        onClick={props.onDismiss}
        data-testid="capture-issue-dismiss"
      >
        {HOME_COPY.dismiss}
      </button>
    </div>
  );
}

export function IssueSheet(props: {
  id: string | null;
  issue: HomeIssue | null;
  returnFocusTo: RefObject<HTMLElement | null>;
  /** Where focus goes when the row is gone: never `<body>`. */
  fallbackFocusTo: RefObject<HTMLElement | null>;
  /** Re-reads the quarantine after Try again or Delete. */
  refresh: () => void;
  /** Native says the recording is deleted, or no longer failed: its rows go. */
  onGone: (id: string) => void;
  /** Dismisses a partial-audio notice: whether it is dismissed (false: it could not be saved). */
  onDismiss: (id: string) => boolean;
  onClose: () => void;
  /** `desktop`: a centred dialog, not a bottom sheet. */
  layout?: "phone" | "desktop";
  /** Rewrites the shared copy for the device it names ("this phone"). */
  text?: (text: string) => string;
}) {
  const layout = props.layout ?? "phone";
  const text = props.text ?? SAME;
  const theme = useSoftTheme();
  const ids = useId();
  const deleteButton = useRef<HTMLButtonElement | null>(null);
  const copy = props.issue ? issueSheetCopy(props.issue) : null;
  const recoverable =
    props.issue !== null && issueIsRecoverable(props.issue)
      ? props.issue.kind
      : null;
  const actions = useFailedActions({
    id: props.id,
    kind: recoverable,
    refresh: props.refresh,
    onGone: props.onGone,
  });
  const shown = recoverable !== null;
  const notice = props.issue !== null && issueIsInformational(props.issue);
  const missing = props.issue ? partialAudioMissingLine(props.issue) : null;
  const closeButton = useRef<HTMLButtonElement | null>(null);
  const [dismissError, setDismissError] = useState<string | null>(null);
  useEffect(() => setDismissError(null), [props.id]);
  const dismiss = () => {
    if (props.id !== null) setDismissError(dismissNotice(props.id, props.onDismiss));
  };
  const confirming = shown && actions.confirming;
  return (
    <Dialog.Root
      open={copy !== null}
      onOpenChange={(open) => !open && props.onClose()}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="soft-sheet-overlay" />
        <Dialog.Content
          className={`soft-skin ${theme} soft-sheet`}
          data-layout={layout}
          data-testid="capture-issue-sheet"
          data-kind={props.issue?.kind}
          onEscapeKeyDown={(event) => {
            if (!confirming) return;
            event.preventDefault();
            actions.keep();
          }}
          onOpenAutoFocus={(event) => {
            if (!notice) return;
            event.preventDefault();
            closeButton.current?.focus();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            const row = props.returnFocusTo.current;
            (row?.isConnected ? row : props.fallbackFocusTo.current)?.focus();
          }}
        >
          <div inert={confirming}>
            <Dialog.Title className="soft-title soft-sheet-title">
              {copy && text(copy.title)}
            </Dialog.Title>
            <Dialog.Description className="soft-sheet-body">
              {copy && text(copy.body)}
            </Dialog.Description>
            {missing !== null && (
              <p className="soft-sheet-body" data-testid="capture-issue-missing">
                {missing}
              </p>
            )}
            {shown && <Actions
                actions={actions}
                text={text}
                canRetry={props.issue !== null && issueCanRetry(props.issue)}
                deleteRef={deleteButton}
              />}
            {notice ? (
              <Notice error={dismissError} onDismiss={dismiss} closeRef={closeButton} />
            ) : (
              <Dialog.Close
                className={shown ? "soft-sheet-quiet" : "soft-sheet-close"}
                data-testid="capture-issue-close"
              >
                {HOME_COPY.close}
              </Dialog.Close>
            )}
          </div>
          {confirming && (
            <SheetDialog
              role="alertdialog"
              titleId={`${ids}-dt`}
              descriptionId={`${ids}-dd`}
              title={text(HOME_COPY.deleteConfirm.title)}
              description={text(HOME_COPY.deleteConfirm.body)}
              onCancel={actions.keep}
              returnFocus={deleteButton}
            >
              <button
                type="button"
                className="pr-keep"
                data-initial=""
                onClick={actions.keep}
                data-testid="capture-issue-keep"
              >
                {HOME_COPY.keep}
              </button>
              <button
                type="button"
                className="pr-discard"
                onClick={actions.confirmDelete}
                data-testid="capture-issue-delete-confirm"
              >
                {HOME_COPY.delete}
              </button>
            </SheetDialog>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
