// What the Home site shows where Recording and Connectors would open. It mounts no recorder and makes no
// storage calls; it only names where the screen lives. It sits inside the shell's <main>.
import { useLocation } from "react-router-dom";

import { MOVED_TO_CHAT_BODY, MOVED_TO_CHAT_LINK, MOVED_TO_CHAT_TITLE } from "@/lib/homeStrings";
import { PAGE_COLUMN, PageHeader } from "./PageHeader";

const TINYCHAT_ORIGIN = "https://tinycloud.chat";

export function MovedToChatPointer() {
  const { pathname } = useLocation();
  return (
    <div className="relative h-full overflow-y-auto" data-scroll-root>
      <PageHeader title={MOVED_TO_CHAT_TITLE} className={PAGE_COLUMN} />
      <div className={`${PAGE_COLUMN} flex flex-col gap-4 pb-[max(1.5rem,env(safe-area-inset-bottom))]`}>
        <p className="text-body text-muted-foreground">{MOVED_TO_CHAT_BODY}</p>
        <a
          href={`${TINYCHAT_ORIGIN}${pathname}`}
          className="flex min-h-11 w-fit items-center rounded-lg border bg-card px-4 text-body font-semibold text-primary hover:bg-surface-2"
        >
          {MOVED_TO_CHAT_LINK}
        </a>
      </div>
    </div>
  );
}
