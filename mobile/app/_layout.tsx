import { Stack } from "expo-router";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { ChatRuntimeProvider } from "../src/chat/runtime";

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <ChatRuntimeProvider>
        <Stack screenOptions={{ headerShown: true, title: "TinyChat" }} />
      </ChatRuntimeProvider>
    </SafeAreaProvider>
  );
}
