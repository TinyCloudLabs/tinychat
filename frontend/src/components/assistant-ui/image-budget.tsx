import { createContext, useContext, useState, useSyncExternalStore, type FC, type ReactNode } from "react";

import { ReplyImageBudget } from "@/lib/imageBudget";
import { IMAGE_PROMPT_COPY } from "@/lib/imageUrlFilter";

const BudgetContext = createContext<ReplyImageBudget | null>(null);

export const useReplyImageBudget = () => useContext(BudgetContext);

const NO_IMAGES = [] as const;
const noSubscribe = () => () => {};
const noWaiting = () => NO_IMAGES;

/** The images a budget holds back that nobody has chosen for yet; re-renders when that changes. */
export function useWaitingImages(budget: ReplyImageBudget | null) {
  return useSyncExternalStore(budget?.subscribe ?? noSubscribe, budget?.waiting ?? noWaiting);
}

function ImageBudgetPrompt({ budget }: { budget: ReplyImageBudget }) {
  const waiting = useWaitingImages(budget);
  if (waiting.length === 0) return null;
  const hosts = [...new Set(waiting.map((image) => image.host))];
  const title = IMAGE_PROMPT_COPY.more.title(waiting.length, hosts);
  const srcs = waiting.map((image) => image.src);
  return (
    <span role="group" aria-label={title} className="my-2 block rounded-lg border border-border bg-muted p-3 text-sm">
      <span className="block font-medium text-foreground">{title}</span>
      <span className="mt-1 block text-xs text-muted-foreground">{IMAGE_PROMPT_COPY.more.why}</span>
      <span className="mt-2 flex gap-2">
        <button
          type="button"
          className="rounded-md border border-border bg-background px-3 py-1 text-sm font-medium"
          onClick={() => budget.decide(srcs, "load")}
        >
          {IMAGE_PROMPT_COPY.load}
        </button>
        <button
          type="button"
          className="rounded-md px-3 py-1 text-sm text-muted-foreground"
          onClick={() => budget.decide(srcs, "skip")}
        >
          {IMAGE_PROMPT_COPY.notNow}
        </button>
      </span>
    </span>
  );
}

/**
 * One reply's images share a budget (lib/imageBudget.ts): wrap the whole reply, and the held images ask once, below it.
 * Inside another scope it adds nothing, so the outermost scope is the reply. A different `messageId` starts a fresh budget,
 * choices included: the thread renders messages by position, so a component can be reused for another message.
 */
export const ImageBudgetScope: FC<{ messageId?: string; children: ReactNode }> = ({ messageId, children }) => {
  const parent = useContext(BudgetContext);
  const [owned, setOwned] = useState(() => ({ messageId, budget: parent ? null : new ReplyImageBudget() }));
  let own = owned;
  if (own.messageId !== messageId) {
    own = { messageId, budget: parent ? null : new ReplyImageBudget() };
    setOwned(own);
  }
  if (!own.budget) return <>{children}</>;
  return (
    <BudgetContext.Provider value={own.budget}>
      {children}
      <ImageBudgetPrompt budget={own.budget} />
    </BudgetContext.Provider>
  );
};
