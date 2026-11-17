import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AssistantRuntimeProvider, ThreadPrimitive, useExternalStoreRuntime, type ThreadMessageLike } from "@assistant-ui/react";

import { TooltipProvider } from "@/components/ui/tooltip";
import { installDom } from "@/test/dom";
import { IMAGE_PROMPT_COPY } from "@/lib/imageUrlFilter";
import { AssistantMessage } from "./Thread";

let restore: (() => void) | undefined;
let mounted: Root | undefined;
afterEach(() => {
  if (mounted) act(() => mounted!.unmount());
  mounted = undefined;
  restore?.();
  restore = undefined;
});

const four = (tag: string) =>
  ["a", "b", "c", "d"].map((n) => `![${n}](https://${n}.example/${tag}.png)`).join("\n\n");

const message = (id: string, text: string): ThreadMessageLike => ({
  id,
  role: "assistant",
  content: [{ type: "text", text }],
  status: { type: "complete", reason: "stop" },
});

function Messages({ messages }: { messages: ThreadMessageLike[] }) {
  const runtime = useExternalStoreRuntime({ messages, convertMessage: (m: ThreadMessageLike) => m, onNew: async () => {} });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <TooltipProvider>
        <ThreadPrimitive.Root>
          <ThreadPrimitive.Messages components={{ AssistantMessage, UserMessage: () => null }} />
        </ThreadPrimitive.Root>
      </TooltipProvider>
    </AssistantRuntimeProvider>
  );
}

async function show(host: HTMLElement, messages: ThreadMessageLike[]) {
  await act(async () => mounted!.render(<Messages messages={messages} />));
  let last = "";
  for (let stable = 0; stable < 4; ) {
    await act(async () => { await Bun.sleep(20); });
    stable = host.innerHTML === last ? stable + 1 : 0;
    last = host.innerHTML;
  }
}

const srcs = (host: HTMLElement) => [...host.querySelectorAll("img")].map((img) => img.getAttribute("src"));
const load = (host: HTMLElement) =>
  [...host.querySelectorAll("button")].find((b) => b.textContent === IMAGE_PROMPT_COPY.load)!;

test("a thread that reuses a message's component for another message gives it a fresh image budget", async () => {
  restore = installDom();
  const host = document.createElement("div");
  document.body.append(host);
  mounted = createRoot(host);

  await show(host, [message("m1", four("x"))]);
  expect(srcs(host)).toEqual(["https://a.example/x.png", "https://b.example/x.png"]);
  await act(async () => { load(host).click(); });
  expect(srcs(host)).toHaveLength(4);

  // The same position now shows another message with the same addresses: the earlier approval is not its approval.
  await show(host, [message("m2", four("x"))]);
  expect(srcs(host)).toEqual(["https://a.example/x.png", "https://b.example/x.png"]);
  expect(host.textContent).toContain(IMAGE_PROMPT_COPY.more.title(2, ["c.example", "d.example"]));
});
