import { StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import {
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
} from "@assistant-ui/react-native";

// Minimal chat surface built from the REAL @assistant-ui/react-native primitives
// driven by the local runtime (provided in _layout via ChatRuntimeProvider).
// This proves the runtime + adapter wire up end to end; styling is intentionally
// bare for the spike.

function UserMessage() {
  return (
    <MessagePrimitive.Root style={[styles.bubble, styles.userBubble]}>
      <MessagePrimitive.Content
        renderText={({ part }) => (
          <Text style={styles.userText}>{part.text}</Text>
        )}
      />
    </MessagePrimitive.Root>
  );
}

function AssistantMessage() {
  return (
    <MessagePrimitive.Root style={[styles.bubble, styles.assistantBubble]}>
      <MessagePrimitive.Content
        renderText={({ part }) => (
          <Text style={styles.assistantText}>{part.text}</Text>
        )}
      />
    </MessagePrimitive.Root>
  );
}

export default function ChatScreen() {
  return (
    <SafeAreaView style={styles.safe} edges={["bottom"]}>
      <ThreadPrimitive.Root style={styles.root}>
        <ThreadPrimitive.Messages
          style={styles.messages}
          contentContainerStyle={styles.messagesContent}
          components={{
            UserMessage,
            AssistantMessage,
          }}
        />
        <ThreadPrimitive.Empty>
          <View style={styles.empty}>
            <Text style={styles.emptyText}>Ask anything to get started.</Text>
          </View>
        </ThreadPrimitive.Empty>
        <ComposerPrimitive.Root style={styles.composer}>
          <ComposerPrimitive.Input
            style={styles.input}
            placeholder="Message TinyChat…"
            multiline
          />
          <ComposerPrimitive.Send style={styles.send}>
            <Text style={styles.sendText}>Send</Text>
          </ComposerPrimitive.Send>
        </ComposerPrimitive.Root>
      </ThreadPrimitive.Root>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "#ffffff" },
  root: { flex: 1 },
  messages: { flex: 1 },
  messagesContent: { padding: 12, gap: 8 },
  empty: { padding: 24, alignItems: "center" },
  emptyText: { color: "#888" },
  bubble: {
    maxWidth: "85%",
    borderRadius: 12,
    paddingVertical: 8,
    paddingHorizontal: 12,
    marginVertical: 4,
  },
  userBubble: { alignSelf: "flex-end", backgroundColor: "#2563eb" },
  assistantBubble: { alignSelf: "flex-start", backgroundColor: "#f1f1f1" },
  userText: { color: "#ffffff" },
  assistantText: { color: "#111111" },
  composer: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 8,
    padding: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "#e5e5e5",
  },
  input: {
    flex: 1,
    minHeight: 40,
    maxHeight: 120,
    borderRadius: 20,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "#d4d4d4",
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  send: {
    borderRadius: 20,
    backgroundColor: "#2563eb",
    paddingHorizontal: 16,
    justifyContent: "center",
    height: 40,
  },
  sendText: { color: "#ffffff", fontWeight: "600" },
});
