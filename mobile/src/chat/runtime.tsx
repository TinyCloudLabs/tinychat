// Runtime provider — mirrors the web pattern: build a local runtime from the
// custom ChatModelAdapter and expose it via AssistantRuntimeProvider so the RN
// Thread/Composer/Message primitives can drive it.
import type { PropsWithChildren } from "react";
import {
  AssistantRuntimeProvider,
  useLocalRuntime,
} from "@assistant-ui/react-native";
import { chatAdapter } from "./adapter";

export function ChatRuntimeProvider({ children }: PropsWithChildren) {
  const runtime = useLocalRuntime(chatAdapter);
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      {children}
    </AssistantRuntimeProvider>
  );
}
