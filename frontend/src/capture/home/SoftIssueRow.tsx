// The row for a recording that has an issue but no Library row yet (TC-871):
// shown by Recent and the Library list alike.
import { MicIcon } from "lucide-react";

import { issueHasSheet, type OrphanIssue } from "./captureIssues";
import { HOME_COPY } from "./homeCopy";
import { SoftRow } from "./SoftRow";
import { useSoftHome } from "./softHome";

export function SoftIssueRow(props: OrphanIssue & { testId: string }) {
  const soft = useSoftHome();
  const { issue } = props;
  return (
    <SoftRow
      icon={MicIcon}
      title={HOME_COPY.voiceNoteTitle}
      meta=""
      issue={issue}
      onActivate={
        issueHasSheet(issue) && soft
          ? (row) => soft.openIssue(issue, row)
          : undefined
      }
      testId={props.testId}
      sourceId={props.id}
    />
  );
}
