import { type FC } from "react";
import {
  ThreadPrimitive,
  ComposerPrimitive,
  MessagePrimitive,
} from "@assistant-ui/react";

const UserMessage: FC = () => (
  <MessagePrimitive.Root className="flex w-full justify-end">
    <div className="max-w-[80%] rounded-2xl bg-primary px-4 py-2 text-sm leading-relaxed text-primary-foreground">
      <MessagePrimitive.Parts />
    </div>
  </MessagePrimitive.Root>
);

const AssistantMessage: FC = () => (
  <MessagePrimitive.Root className="flex w-full justify-start">
    <div className="max-w-[80%] rounded-2xl bg-muted px-4 py-2 text-sm leading-relaxed text-foreground">
      <MessagePrimitive.Parts
        components={{
          Text: ({ text }) => <span className="whitespace-pre-wrap">{text}</span>,
        }}
      />
    </div>
  </MessagePrimitive.Root>
);

export const Thread: FC = () => {
  return (
    <ThreadPrimitive.Root className="flex h-full flex-col bg-background">
      <ThreadPrimitive.Viewport className="flex flex-1 flex-col gap-4 overflow-y-auto px-4 py-6">
        <ThreadPrimitive.Empty>
          <div className="m-auto flex flex-col items-center gap-2 text-center text-muted-foreground">
            <p className="text-base font-medium text-foreground">Start a conversation</p>
            <p className="text-sm">Ask anything. Your chats are stored in your TinyCloud space.</p>
          </div>
        </ThreadPrimitive.Empty>

        <ThreadPrimitive.Messages
          components={{
            UserMessage,
            AssistantMessage,
          }}
        />
      </ThreadPrimitive.Viewport>

      <div className="border-t border-border bg-background px-4 py-3">
        <ComposerPrimitive.Root className="flex items-end gap-2 rounded-xl border border-input bg-background px-3 py-2 focus-within:ring-1 focus-within:ring-ring">
          <ComposerPrimitive.Input
            autoFocus
            rows={1}
            placeholder="Message TinyChat…"
            className="max-h-40 flex-1 resize-none bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
          <ThreadPrimitive.If running={false}>
            <ComposerPrimitive.Send className="rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50">
              Send
            </ComposerPrimitive.Send>
          </ThreadPrimitive.If>
          <ThreadPrimitive.If running>
            <ComposerPrimitive.Cancel className="rounded-lg border border-input px-3 py-1.5 text-sm font-medium text-foreground">
              Stop
            </ComposerPrimitive.Cancel>
          </ThreadPrimitive.If>
        </ComposerPrimitive.Root>
      </div>
    </ThreadPrimitive.Root>
  );
};
