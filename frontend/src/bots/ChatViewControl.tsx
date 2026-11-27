// Settings → Chat view (TC-3325): Classic or Bots, kept per account on this device (chatViewSetting.ts). Bots is
// offered only to an account the backend lets into bots; for any other it stays off and says so.
import { useId } from "react";
import { MessagesSquareIcon } from "lucide-react";

import { SectionCard } from "@/components/ui/section-card";
import { botsApi as defaultBotsApi, type BotsApi } from "./botsApi";
import { BOT_VIEW_STRINGS } from "./botsStrings";
import { useSavedChatView, type ChatView } from "./chatViewSetting";
import { useBotsAdmitted } from "./useBotsAdmitted";

const text = BOT_VIEW_STRINGS.chatView;

export function ChatViewSetting({ account, api = defaultBotsApi }: { account: string | null; api?: BotsApi }) {
  const [saved, setView] = useSavedChatView(account);
  const admitted = useBotsAdmitted(account ? api : null);
  const id = useId();
  if (!account) return null;
  // Admitted accounts default to Bots unless they explicitly chose Classic; non-admitted accounts stay on Classic.
  const shown: ChatView = admitted === true ? (saved ?? "bots") : "classic";
  const option = (value: ChatView, label: string, disabled: boolean) => (
    <label className="flex min-h-11 items-center gap-2 text-sm has-[:disabled]:opacity-50 fine:min-h-9">
      <input type="radio" name={id} value={value} checked={shown === value} disabled={disabled}
        aria-describedby={admitted === false && disabled ? `${id}-off` : undefined}
        onChange={() => setView(value)} className="size-4 accent-foreground" />
      {label}
    </label>
  );
  return (
    <SectionCard icon={MessagesSquareIcon} title={text.label}>
      <fieldset aria-describedby={`${id}-help`} data-chat-view-setting="">
        <legend className="sr-only">{text.label}</legend>
        <p id={`${id}-help`} className="text-xs text-muted-foreground">{text.helper}</p>
        <div className="mt-2 flex flex-wrap gap-x-6">
          {option("classic", text.classic, false)}
          {option("bots", text.bots, admitted !== true)}
        </div>
        {admitted === false ? <p id={`${id}-off`} className="text-xs text-muted-foreground">{text.notAdmitted}</p> : null}
      </fieldset>
    </SectionCard>
  );
}
