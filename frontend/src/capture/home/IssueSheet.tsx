// The small sheet a failed Recent row opens (TC-871): what went wrong, in a
// sentence, and Close. A recording that could not be recovered also gets Try
// again and Delete (TC-868); Delete asks first. A labelled modal dialog;
// closing returns focus to the row that opened it.
import * as Dialog from "@radix-ui/react-dialog";
import { useId, useRef, type RefObject } from "react";

import {
  issueCanRetry,
  issueIsRecoverable,
  issueSheetCopy,
  type HomeIssue,
} from "./captureIssues";
import {
  useFailedActions,
  useFailedActionsAvailable,
  type FailedActions,
} from "./failedActions";
import { HOME_COPY } from "./homeCopy";
import { useSoftTheme } from "./softTheme";
import { SheetDialog } from "../recorder/final/SheetDialog";
import "../recorder/final/phone.css";

function Actions(props: {
  actions: FailedActions;
  canRetry: boolean;
  deleteRef: RefObject<HTMLButtonElement | null>;
}) {
  const { actions } = props;
  const busy = actions.busy !== null;
  return (
    <div className="soft-sheet-actions" data-busy={busy ? "true" : undefined}>
      {actions.error !== null && (
        <p role="alert" className="soft-sheet-error" data-testid="capture-issue-error">
          {actions.error}
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
  onClose: () => void;
}) {
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
  const shown = useFailedActionsAvailable() && recoverable !== null;
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
          data-layout="phone"
          data-testid="capture-issue-sheet"
          data-kind={props.issue?.kind}
          onEscapeKeyDown={(event) => {
            if (!confirming) return;
            event.preventDefault();
            actions.keep();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            const row = props.returnFocusTo.current;
            (row?.isConnected ? row : props.fallbackFocusTo.current)?.focus();
          }}
        >
          <div inert={confirming}>
            <Dialog.Title className="soft-title soft-sheet-title">
              {copy?.title}
            </Dialog.Title>
            <Dialog.Description className="soft-sheet-body">
              {copy?.body}
            </Dialog.Description>
            {shown && <Actions
                actions={actions}
                canRetry={props.issue !== null && issueCanRetry(props.issue)}
                deleteRef={deleteButton}
              />}
            <Dialog.Close
              className={shown ? "soft-sheet-quiet" : "soft-sheet-close"}
              data-testid="capture-issue-close"
            >
              {HOME_COPY.close}
            </Dialog.Close>
          </div>
          {confirming && (
            <SheetDialog
              role="alertdialog"
              titleId={`${ids}-dt`}
              descriptionId={`${ids}-dd`}
              title={HOME_COPY.deleteConfirm.title}
              description={HOME_COPY.deleteConfirm.body}
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
