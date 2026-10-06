// Upload audio (TC-761): Capture's Upload action opens this sheet, a bottom
// sheet on phones and a dialog on wider screens. Its body is the upload panel
// (chat/AudioUploadPanel.tsx) on the app-wide runner, so closing the sheet
// never stops an upload: the In progress row keeps showing it.
import type { SessionStore } from "@tinyboilerplate/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { AudioUploadPanel } from "@/chat/AudioUploadPanel";
import { ResponsiveSheet, ResponsiveSheetBody } from "@/components/ui/responsive-sheet";

export interface UploadSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tcw: TinyCloudWeb;
  backendUrl: string;
  sessionStore: SessionStore;
}

export function UploadSheet({ open, onOpenChange, tcw, backendUrl, sessionStore }: UploadSheetProps) {
  return (
    <ResponsiveSheet open={open} onOpenChange={onOpenChange} title="Upload audio" contentProps={{ "data-testid": "upload-sheet" }}>
      <ResponsiveSheetBody className="pb-5">
        <AudioUploadPanel tcw={tcw} backendUrl={backendUrl} sessionStore={sessionStore} onDone={() => onOpenChange(false)} />
      </ResponsiveSheetBody>
    </ResponsiveSheet>
  );
}
