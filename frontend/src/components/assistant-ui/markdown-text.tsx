import { useCallback, useState, type FC } from "react";
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

const defaultComponents = memoizeMarkdownComponents({
  CodeHeader,
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
