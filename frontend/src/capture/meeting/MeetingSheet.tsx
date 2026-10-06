// Send a notetaker (TC-761): Capture's Meeting action opens this sheet, a
// bottom sheet on phones and a dialog on wider screens. Its body is the
// notetaker's view (chat/TranscriberSection.tsx) on the one `useMeetingBot`
// Capture owns, so the sessions it lists are the In progress rows' sessions.
import { meetingBotViewProps, TranscriberView, type MeetingBot } from "@/chat/TranscriberSection";
import { ResponsiveSheet, ResponsiveSheetBody } from "@/components/ui/responsive-sheet";

export interface MeetingSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  bot: MeetingBot;
}

export function MeetingSheet({ open, onOpenChange, bot }: MeetingSheetProps) {
  return (
    <ResponsiveSheet open={open} onOpenChange={onOpenChange} title="Send a notetaker" contentProps={{ "data-testid": "meeting-sheet" }}>
      <ResponsiveSheetBody className="pb-5">
        <TranscriberView {...meetingBotViewProps(bot)} />
      </ResponsiveSheetBody>
    </ResponsiveSheet>
  );
}
