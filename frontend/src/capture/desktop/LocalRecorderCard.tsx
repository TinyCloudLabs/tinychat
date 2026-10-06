// Record on this Mac (TC-761, desktop app only): the local recorder, at the
// top of Capture. Capture stays mounted while another destination shows, and
// this card sits in a fixed place in its tree, so navigating never unmounts
// the panel and a recording never stops; only signing out or closing the
// window does (unmounting stops capture without saving a transcript).
import type { SessionStore } from "@tinyboilerplate/client";
import type { TinyCloudWeb } from "@tinycloud/web-sdk";

import { LocalTranscriberPanel } from "@/chat/LocalTranscriber";
import { InfoTip } from "@/components/ui/info-tip";

export function LocalRecorderCard(props: { tcw: TinyCloudWeb; backendUrl: string; sessionStore: SessionStore }) {
  return (
    <section aria-labelledby="local-recorder-title" data-testid="local-recorder-card" className="rounded-xl border border-border bg-card p-4">
      <div className="flex items-center gap-0.5">
        <h2 id="local-recorder-title" className="text-headline">
          Record on this Mac
        </h2>
        <InfoTip label="About recording on this Mac">Records your microphone and the Mac&apos;s audio. The transcript is saved to Library.</InfoTip>
      </div>
      <LocalTranscriberPanel tcw={props.tcw} backendUrl={props.backendUrl} sessionStore={props.sessionStore} />
    </section>
  );
}
