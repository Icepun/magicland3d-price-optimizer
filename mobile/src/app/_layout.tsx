import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { GestureHandlerRootView } from "react-native-gesture-handler";

import { AppQueryProvider } from "@/lib/query";
import { UpdateGate } from "@/components/UpdateGate";
import { ML } from "@/theme/colors";

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: ML.bg }}>
      <AppQueryProvider>
        <StatusBar style="light" />
        <Stack
          screenOptions={{
            headerShown: false,
            contentStyle: { backgroundColor: ML.bg },
            animation: "slide_from_right",
          }}
        />
        <UpdateGate />
      </AppQueryProvider>
    </GestureHandlerRootView>
  );
}
