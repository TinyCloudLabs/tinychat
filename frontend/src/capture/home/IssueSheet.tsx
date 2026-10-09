// The small sheet a failed Recent row opens (TC-871): what went wrong, in a
// sentence, and Close. No Try again or Delete until TC-868 gives native a
// retry and a discard. A labelled modal dialog; closing returns focus to the
// row that opened it.
import * as Dialog from "@radix-ui/react-dialog";
import type { RefObject } from "react";

import type { RecorderCaptureIssue } from "../recorder/recorderReducer";
import { issueSheetCopy } from "./captureIssues";
import { HOME_COPY } from "./homeCopy";
import { useSoftTheme } from "./softTheme";

export function IssueSheet(props: {
  issue: RecorderCaptureIssue | null;
  returnFocusTo: RefObject<HTMLElement | null>;
  onClose: () => void;
}) {
  const theme = useSoftTheme();
  const copy = props.issue ? issueSheetCopy(props.issue) : null;
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
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            props.returnFocusTo.current?.focus();
          }}
        >
          <Dialog.Title className="soft-title soft-sheet-title">
            {copy?.title}
          </Dialog.Title>
          <Dialog.Description className="soft-sheet-body">
            {copy?.body}
          </Dialog.Description>
          <Dialog.Close
            className="soft-sheet-close"
            data-testid="capture-issue-close"
          >
            {HOME_COPY.close}
          </Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
