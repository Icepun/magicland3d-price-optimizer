import * as Notifications from "expo-notifications";
import * as Device from "expo-device";
import Constants from "expo-constants";
import { Platform } from "react-native";
import { execute } from "@/lib/turso";

/**
 * Push bildirimleri (baskı bitti). Masaüstü relay'i baskı tamamlanınca, mobilin buraya yazdığı
 * Expo push token'larına bildirim gönderir → telefon KAPALIYKEN de düşer.
 *
 * NOT: Uzak push Expo Go'da çalışmaz (SDK 53+); dev-client veya standalone (EAS) build gerekir.
 */

// Önplanda bildirim geldiğinde göster (SDK 56 davranış şekli).
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

const EXPO_PROJECT_ID =
  (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)?.eas?.projectId ??
  "94ecc654-9a9e-41b2-974f-a9d3aa090696";

/** İzin iste + Expo push token al + PushToken tablosuna yaz. Tamamen defensive (hata → sessiz). */
export async function registerForPush(): Promise<void> {
  try {
    if (!Device.isDevice) return; // emülatörde uzak push yok

    if (Platform.OS === "android") {
      await Notifications.setNotificationChannelAsync("default", {
        name: "Baskı bildirimleri",
        importance: Notifications.AndroidImportance.HIGH,
        sound: "default",
      });
    }

    const existing = await Notifications.getPermissionsAsync();
    let granted = existing.granted;
    if (!granted) granted = (await Notifications.requestPermissionsAsync()).granted;
    if (!granted) return;

    const tokenResp = await Notifications.getExpoPushTokenAsync({ projectId: EXPO_PROJECT_ID });
    const token = tokenResp?.data;
    if (!token) return;

    await execute(
      `INSERT INTO PushToken (token, platform, updatedAt) VALUES (?, ?, ?)
       ON CONFLICT(token) DO UPDATE SET platform = excluded.platform, updatedAt = excluded.updatedAt`,
      [token, Platform.OS, new Date().toISOString()]
    );
  } catch {
    /* push kurulamadı → sessiz; uygulama yine çalışır */
  }
}
