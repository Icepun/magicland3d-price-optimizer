import * as Notifications from "expo-notifications";
import * as Device from "expo-device";
import Constants from "expo-constants";
import { AppState, Platform, type AppStateStatus } from "react-native";
import { execute } from "@/lib/turso";

/**
 * Push bildirimleri (baskı bitti / hatayla durdu / sipariş uyarıları).
 *
 * Masaüstü relay'i + sipariş izleyicisi, mobilin buraya yazdığı Expo push token'larına bildirim
 * gönderir (masaüstü: src/lib/push-notify.ts → PushToken tablosu) → telefon KAPALIYKEN de düşer.
 *
 * ⚠️ NATIVE MODÜL UYARISI — bu dosya geçmişte bir kez açılış çökmesine yol açtı, tekrarlamasın:
 * expo-notifications ve expo-device NATIVE modüllerdir. Bu dosyayı içeren JS, native modülü
 * OLMAYAN bir binary'de çalışırsa `requireNativeModule` ile AÇILIŞTA ÇÖKER. Bu yüzden:
 *   1. Paketler kurulu + app.json "plugins" içinde "expo-notifications" OLMALI (ikisi de yapıldı).
 *   2. Bu sürüm YALNIZ yeni bir NATIVE EAS build ile dağıtılmalı — salt-JS OTA YETMEZ.
 *
 * KORUMA: app.json'da `runtimeVersion.policy = "fingerprint"`. Native bağımlılık eklemek parmak
 * izini DEĞİŞTİRİR → bu JS eski binary'lere OTA ile ASLA düşmez. BU POLİTİKAYI KALDIRMA.
 *
 * NOT: Uzak push Expo Go'da çalışmaz (SDK 53+); dev-client veya standalone (EAS) build gerekir.
 *
 * Kayıt neden tek seferlik DEĞİL: ilk açılışta ağ yoksa / kullanıcı izni sonra verirse / Expo
 * token'ı döndürürse tek deneme sessizce kaybolurdu. Artık uygulama her öne geldiğinde
 * (AppState "active") tekrar denenir ve token DEĞİŞMEDİKÇE veritabanına yazılmaz.
 */

// Önplanda bildirim geldiğinde de göster (SDK 56 davranış şekli).
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

/**
 * Veritabanına yazılacak tarih damgası — masaüstünün kanonik biçimiyle BİREBİR aynı
 * ("2026-08-13T07:00:00.000+00:00"). Aynı kolona iki farklı biçim yazılırsa sıralama ve
 * tarih filtreleri sessizce yanlış sonuç veriyor.
 */
function simdiKanonik(): string {
  return new Date().toISOString().replace(/Z$/, "+00:00");
}

const EXPO_PROJECT_ID =
  (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)?.eas?.projectId ??
  "94ecc654-9a9e-41b2-974f-a9d3aa090696";

/** Başarılı kayıttan sonra bu kadar süre geçmeden tekrar denemeye gerek yok. */
const TAZELEME_ARALIGI_MS = 6 * 60 * 60 * 1000;
/** Başarısız denemelerde artan bekleme (ağ gelene kadar). */
const YENIDEN_DENEME_MS = [5_000, 20_000, 60_000, 300_000];

export type PushDurumKodu =
  | "bilinmiyor"
  | "hazir"
  | "izin-yok"
  | "cihaz-degil"
  | "baglanti-yok"
  | "hata";

export interface PushKayitDurumu {
  kod: PushDurumKodu;
  /** Arayüzde doğrudan gösterilebilen TEK satır, sade Türkçe. */
  mesaj: string;
  /** Kullanıcı iOS ayarlarından izin vermeli mi? */
  ayarlardanIzinGerek: boolean;
  /** Son başarılı kayıt zamanı (ISO) */
  guncellendi: string | null;
}

let durum: PushKayitDurumu = {
  kod: "bilinmiyor",
  mesaj: "Bildirimler hazırlanıyor.",
  ayarlardanIzinGerek: false,
  guncellendi: null,
};

const aboneler = new Set<(d: PushKayitDurumu) => void>();

/** Anlık kayıt durumu (arayüz bunu okuyup kullanıcıya tek satır gösterir). */
export function pushDurumu(): PushKayitDurumu {
  return durum;
}

/** Durum değişimlerini dinle; dönen fonksiyon aboneliği bırakır. */
export function pushDurumunaAbone(cb: (d: PushKayitDurumu) => void): () => void {
  aboneler.add(cb);
  return () => {
    aboneler.delete(cb);
  };
}

function durumYaz(yeni: Partial<PushKayitDurumu> & { kod: PushDurumKodu; mesaj: string }): void {
  durum = { ayarlardanIzinGerek: false, guncellendi: durum.guncellendi, ...yeni };
  for (const cb of aboneler) {
    try {
      cb(durum);
    } catch (err) {
      console.warn("[push] durum dinleyicisi hata verdi:", err instanceof Error ? err.message : err);
    }
  }
}

/**
 * Veritabanına yazılmış son token — aynı token için her açılışta tekrar tekrar yazmayalım diye.
 * (Kalıcı depo yok: uygulama her tamamen kapanıp açıldığında en fazla BİR yazma olur, bu da
 * "en son ne zaman kaydoldu" bilgisini tazelediği için zaten istenen davranış.)
 */
let yazilanToken: string | null = null;
let sonBasariliMs = 0;
let denemeSuruyor = false;
let denemeSayaci = 0;
let yenidenDenemeZamani: ReturnType<typeof setTimeout> | null = null;

function yenidenDenemeyiPlanla(): void {
  if (yenidenDenemeZamani) return;
  const bekle = YENIDEN_DENEME_MS[Math.min(denemeSayaci, YENIDEN_DENEME_MS.length - 1)];
  yenidenDenemeZamani = setTimeout(() => {
    yenidenDenemeZamani = null;
    void registerForPush();
  }, bekle);
}

function izinVarMi(ayar: Notifications.NotificationPermissionsStatus): boolean {
  // iOS'ta "provisional" izin de bildirim göndermeye yeter.
  return (
    ayar.granted || ayar.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL
  );
}

/**
 * İzin iste + Expo push token al + PushToken tablosuna yaz.
 * Hata FIRLATMAZ; sonucu okunabilir bir duruma çevirir (arayüz `pushDurumu()` ile gösterir).
 */
export async function registerForPush(zorla = false): Promise<PushKayitDurumu> {
  if (denemeSuruyor) return durum;
  denemeSuruyor = true;
  try {
    if (!Device.isDevice) {
      durumYaz({ kod: "cihaz-degil", mesaj: "Bildirimler yalnızca gerçek telefonda çalışır." });
      return durum;
    }

    // Yakın zamanda başarılıysa tekrar uğraşma (her öne gelişte ağ trafiği olmasın).
    if (!zorla && durum.kod === "hazir" && Date.now() - sonBasariliMs < TAZELEME_ARALIGI_MS) {
      return durum;
    }

    if (Platform.OS === "android") {
      try {
        await Notifications.setNotificationChannelAsync("default", {
          name: "Baskı bildirimleri",
          importance: Notifications.AndroidImportance.HIGH,
          sound: "default",
        });
      } catch (err) {
        console.warn("[push] bildirim kanalı kurulamadı:", err instanceof Error ? err.message : err);
      }
    }

    let ayar: Notifications.NotificationPermissionsStatus;
    try {
      ayar = await Notifications.getPermissionsAsync();
      if (!izinVarMi(ayar)) ayar = await Notifications.requestPermissionsAsync();
    } catch (err) {
      console.warn("[push] izin sorulamadı:", err instanceof Error ? err.message : err);
      denemeSayaci += 1;
      durumYaz({ kod: "hata", mesaj: "Bildirim izni alınamadı, birazdan tekrar denenecek." });
      yenidenDenemeyiPlanla();
      return durum;
    }

    if (!izinVarMi(ayar)) {
      // Reddedildi: SESSİZ geçmiyoruz — kullanıcı neden bildirim almadığını görebilmeli.
      durumYaz({
        kod: "izin-yok",
        mesaj: ayar.canAskAgain
          ? "Bildirim izni verilmedi."
          : "Bildirim izni kapalı. Telefon ayarlarından açın.",
        ayarlardanIzinGerek: !ayar.canAskAgain,
      });
      return durum;
    }

    let token: string | null = null;
    try {
      const tokenResp = await Notifications.getExpoPushTokenAsync({ projectId: EXPO_PROJECT_ID });
      token = tokenResp?.data ?? null;
    } catch (err) {
      console.warn("[push] token alınamadı:", err instanceof Error ? err.message : err);
      denemeSayaci += 1;
      durumYaz({ kod: "baglanti-yok", mesaj: "Bağlantı yok, bildirim kaydı birazdan denenecek." });
      yenidenDenemeyiPlanla();
      return durum;
    }

    if (!token) {
      denemeSayaci += 1;
      durumYaz({ kod: "hata", mesaj: "Bildirim kaydı alınamadı, birazdan tekrar denenecek." });
      yenidenDenemeyiPlanla();
      return durum;
    }

    // Token değişmediyse veritabanına dokunma (gereksiz yazma yok).
    if (token === yazilanToken) {
      sonBasariliMs = Date.now();
      denemeSayaci = 0;
      durumYaz({ kod: "hazir", mesaj: "Bildirimler açık." });
      return durum;
    }

    try {
      // Masaüstü bu tabloyu okuyup push gönderir. Aynı cihaz tekrar açılınca ON CONFLICT ile tazelenir.
      //
      // ⚠️ `createdAt` AÇIKÇA yazılır: kolonun tablo varsayılanı `CURRENT_TIMESTAMP` ve o değer
      // "2026-08-13 07:00:00" (boşluklu) biçiminde. Metin sıralamasında boşluk 'T'den küçük
      // olduğu için o satırlar sıralamanın ve tarih filtrelerinin dışına düşüyor; masaüstünün
      // açılış onarımı kolonu tek biçime çekiyor, bu yazım onu bozuyordu.
      const damga = simdiKanonik();
      const sonuc = await execute(
        `INSERT INTO PushToken (token, platform, createdAt, updatedAt) VALUES (?, ?, ?, ?)
         ON CONFLICT(token) DO UPDATE SET platform = excluded.platform, updatedAt = excluded.updatedAt`,
        [token, Platform.OS, damga, damga]
      );
      if (!sonuc || sonuc.rowsAffected < 1) {
        // Yazma sessizce boş döndüyse kayıt YOK demektir; başarı sayma.
        throw new Error("kayıt satırı yazılmadı");
      }
    } catch (err) {
      console.warn("[push] token kaydedilemedi:", err instanceof Error ? err.message : err);
      denemeSayaci += 1;
      durumYaz({ kod: "baglanti-yok", mesaj: "Bağlantı yok, bildirim kaydı birazdan denenecek." });
      yenidenDenemeyiPlanla();
      return durum;
    }

    yazilanToken = token;
    sonBasariliMs = Date.now();
    denemeSayaci = 0;
    durumYaz({ kod: "hazir", mesaj: "Bildirimler açık.", guncellendi: new Date().toISOString() });
    console.info("[push] bildirim kaydı tamam");
    return durum;
  } finally {
    denemeSuruyor = false;
  }
}

/**
 * Kaydı başlat: hemen bir kez dener, sonra uygulama her öne geldiğinde ve Expo token'ı
 * kendiliğinden değiştiğinde tekrar dener. Dönen fonksiyon dinleyicileri kaldırır.
 */
export function startPushRegistration(): () => void {
  void registerForPush();

  const appSub = AppState.addEventListener("change", (next: AppStateStatus) => {
    if (next === "active") void registerForPush();
  });

  // Expo token'ı nadiren kendiliğinden yenilenir; eskisi anında geçersiz olur.
  let tokenSub: { remove: () => void } | null = null;
  try {
    tokenSub = Notifications.addPushTokenListener(() => {
      void registerForPush(true);
    });
  } catch (err) {
    console.warn("[push] token dinleyicisi kurulamadı:", err instanceof Error ? err.message : err);
  }

  return () => {
    appSub.remove();
    tokenSub?.remove();
    if (yenidenDenemeZamani) {
      clearTimeout(yenidenDenemeZamani);
      yenidenDenemeZamani = null;
    }
  };
}
