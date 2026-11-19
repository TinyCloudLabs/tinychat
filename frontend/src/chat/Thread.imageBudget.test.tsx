import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AssistantRuntimeProvider, ThreadPrimitive, useExternalStoreRuntime, type ThreadMessageLike } from "@assistant-ui/react";

import { TooltipProvider } from "@/components/ui/tooltip";
import { installDom } from "@/test/dom";
import { HEAVY_HOSTS, HEAVY_THAT_FIT as FIT, heavyImageAddress } from "@/lib/imageBudget.fixture";
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

// Heavy addresses (lib/imageBudget.fixture.ts): the first FIT fit in a reply's budget, the last two do not.
const address = (host: string, tag: string) => heavyImageAddress(host, tag);
const heavyReply = (tag: string) => HEAVY_HOSTS.map((host) => `![${host[0]}](${address(host, tag)})`).join("\n\n");

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

  const silent = HEAVY_HOSTS.slice(0, FIT).map((host) => address(host, "x"));
  await show(host, [message("m1", heavyReply("x"))]);
  expect(srcs(host)).toEqual(silent);
  await act(async () => { load(host).click(); });
  expect(srcs(host)).toHaveLength(FIT + 2);

  // The same position now shows another message with the same addresses: the earlier approval is not its approval.
  await show(host, [message("m2", heavyReply("x"))]);
  expect(srcs(host)).toEqual(silent);
  expect(host.textContent).toContain(IMAGE_PROMPT_COPY.more.title(2, HEAVY_HOSTS.slice(FIT)));
});
