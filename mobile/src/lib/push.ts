import { Platform } from "react-native";
import { execute } from "@/lib/turso";

/**
 * Push bildirimleri (baskı bitti). Masaüstü relay'i baskı tamamlanınca, mobilin buraya yazdığı
 * Expo push token'larına bildirim gönderir → telefon KAPALIYKEN de düşer.
 *
 * ÖNEMLİ (OTA güvenliği): expo-notifications & expo-device NATIVE modüllerdir. Mevcut yüklü binary
 * onları İÇERMİYORSA (app.json'a "expo-notifications" plugin'i eklenip YENİ bir EAS native build
 * alınana dek içermez), bu modülleri ÜST SEVİYEDE import etmek `requireNativeModule` ile AÇILIŞTA
 * ÇÖKERTİR. Bu yüzden importlar registerForPush İÇİNDE DİNAMİK + try/catch ile yapılır → native modül
 * yoksa sessizce atlanır, uygulama yine açılır (sadece-JS OTA güvenli). Uzak push ancak
 * expo-notifications içeren native build'de fiilen çalışır (Expo Go'da çalışmaz, SDK 53+).
 */

const EXPO_PROJECT_ID = "94ecc654-9a9e-41b2-974f-a9d3aa090696";

/** İzin iste + Expo push token al + PushToken tablosuna yaz. Tamamen defensive (native yok/izin yok/hata → sessiz). */
export async function registerForPush(): Promise<void> {
  try {
    // Dinamik import: native modül binary'de yoksa burada throw → catch yutar (üst seviyede DEĞİL).
    const Device = await import("expo-device");
    if (!Device.isDevice) return; // emülatör → uzak push yok

    const Notifications = await import("expo-notifications");

    // Önplanda bildirim geldiğinde göster (SDK 56 davranış şekli).
    Notifications.setNotificationHandler({
      handleNotification: async () => ({
        shouldShowBanner: true,
        shouldShowList: true,
        shouldPlaySound: true,
        shouldSetBadge: false,
      }),
    });

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
    /* push kurulamadı (native modül yok / izin yok / hata) → sessiz; uygulama yine çalışır */
  }
}
