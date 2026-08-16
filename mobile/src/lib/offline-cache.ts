import { dehydrate, hydrate, type QueryClient } from "@tanstack/react-query";
import { File, Paths } from "expo-file-system";
import { Platform } from "react-native";

import {
  ONBELLEK_BICIMI,
  jsonGuvenliMi,
  kaliciSorguMu,
  onbellekGecerliMi,
} from "@/lib/offline-cache-policy";

/**
 * ÇEVRİMDIŞI ÖNBELLEK — uygulama kapatılıp açılınca veriler HEMEN ekranda.
 *
 * SORUN: React Query önbelleği yalnız bellekte duruyordu. Uygulama arka planda öldürülünce
 * (iOS bunu sık yapar) her açılış SIFIRDAN veri çekiyordu: atölyede zayıf ağda 5-10 saniye
 * boş ekran, metroda/depoda hiç veri yok. Oysa "dün 12 sipariş vardı" bilgisi bayat da olsa
 * hiç yoktan iyidir.
 *
 * ÇÖZÜM: önbellek diske yazılıyor, açılışta geri yükleniyor. Ekranlar bayat veriyi anında
 * gösterip arkada tazeliyor (`FreshnessStamp` verinin ne kadar eski olduğunu YAZIYOR — sessizce
 * eski veri göstermek yalan olurdu).
 *
 * ⚠️ NEDEN `expo-file-system`: bu modül UYGULAMANIN İÇİNDE ZATEN VAR (expo-asset üzerinden
 * otomatik bağlanıyor). `async-storage` gibi yeni bir native paket eklemek çalışma parmak izini
 * değiştirir ve telefonun OTA kanalını keser — yeni TestFlight derlemesi yüklenene kadar hiçbir
 * güncelleme ulaşmaz. Bu yüzden hazır modülle çözüldü.
 */

/** Diske yazma sıklığı: her sorgu değişiminde yazmak ana iş parçacığını meşgul eder. */
const YAZMA_ARALIGI_MS = 4_000;

/**
 * Dosya nesnesi TEMBEL kurulur (modül yüklenirken DEĞİL).
 *
 * ⚠️ Modül düzeyinde `new File(...)` yazmak `eas update`'i düşürüyordu: yayın adımı web
 * çıktısını da üretiyor ve expo-router'ı Node içinde çalıştırıyor; orada `expo-file-system`'in
 * web karşılığı yapıcıda patlıyor ("validatePath is not a function"). iOS derlemesi sorunsuz
 * geçtiği için hata ancak yayın anında görülüyordu. Tembel kurulum + web kısa devresi ikisini
 * de kapatıyor: telefon dosyayı ilk kullanımda açar, web hiç açmaz.
 */
let dosya: File | null = null;
function onbellekDosyasi(): File | null {
  if (Platform.OS === "web") return null; // kalıcı önbellek yalnız cihazda
  if (!dosya) dosya = new File(Paths.cache, "mlhub-query-cache.json");
  return dosya;
}

interface KalicilikDosyasi {
  bicim: number;
  yazilma: number;
  durum: unknown;
}

/**
 * Önbelleği diskten yükle. Açılışta BİR KEZ, ilk ekran çizilmeden çağrılır.
 * Her hata sessizce yutulur: kalıcı önbellek bir kolaylık, açılışı engellemesi kabul edilemez.
 */
export function loadOfflineCache(qc: QueryClient): void {
  /**
   * ⚠️ HER ŞEY TEK `try` İÇİNDE — dosya nesnesinin KURULUMU dahil.
   *
   * Bu fonksiyon `useState` başlatıcısında, ilk render'dan önce çalışıyor; buradan fırlayan
   * herhangi bir hata uygulamayı açılışta kapatır. Bir tur `onbellekDosyasi()` çağrısı try'ın
   * DIŞINDAYDI: native tarafta beklenmedik bir durumda uygulama hiç açılmazdı. Kalıcı önbellek
   * bir kolaylıktır; açılışı riske atma hakkı yok.
   */
  let DOSYA: File | null = null;
  try {
    DOSYA = onbellekDosyasi();
    if (!DOSYA || !DOSYA.exists) return;
    const dosya = JSON.parse(DOSYA.textSync()) as KalicilikDosyasi;
    if (!onbellekGecerliMi(dosya, Date.now())) {
      DOSYA.delete(); // eski biçim ya da bayat → temizle, uygulama boş açılsın
      return;
    }
    hydrate(qc, dosya.durum);
  } catch {
    // Bozuk/yarım yazılmış dosya ya da geri yükleme hatası → at, uygulama boş ama ÇALIŞIR açılsın.
    try {
      DOSYA?.delete();
    } catch {
      /* dosya silinemedi; bir sonraki yazma üzerine yazacak */
    }
  }
}

/** Diske yaz (senkron yazma ~1ms; dosya küçük ve tek seferde değiştirilir). */
function diskeYaz(qc: QueryClient): void {
  try {
    const DOSYA = onbellekDosyasi(); // kurulum da try içinde — bkz. loadOfflineCache notu
    if (!DOSYA) return;
    const durum = dehydrate(qc, {
      shouldDehydrateQuery: (q) =>
        kaliciSorguMu(q.queryKey) &&
        q.state.status === "success" &&
        // İKİNCİ SAVUNMA: `Map`/`Set` sessizce `{}` yazılır ve ancak geri yüklenirken,
        // kullanıcının telefonunda, açılış çökmesi olarak patlar. Zehirli veri diske inmesin.
        jsonGuvenliMi(q.state.data),
    });
    if (durum.queries.length === 0) return; // yazacak bir şey yok; var olanı silme
    const govde: KalicilikDosyasi = { bicim: ONBELLEK_BICIMI, yazilma: Date.now(), durum };
    DOSYA.write(JSON.stringify(govde));
  } catch {
    /* disk dolu/izin yok → kalıcılık kapalı kalır, uygulama çalışmaya devam eder */
  }
}

/**
 * Önbellek değişimlerini izlemeye başla. Dönen fonksiyon aboneliği bitirir.
 * Yazma kısılır (throttle): sipariş listesi güncellenirken saniyede onlarca kez yazılmaz.
 */
export function startOfflineCachePersist(qc: QueryClient): () => void {
  let zamanlayici: ReturnType<typeof setTimeout> | null = null;
  const abone = qc.getQueryCache().subscribe(() => {
    if (zamanlayici) return;
    zamanlayici = setTimeout(() => {
      zamanlayici = null;
      diskeYaz(qc);
    }, YAZMA_ARALIGI_MS);
  });
  return () => {
    if (zamanlayici) clearTimeout(zamanlayici);
    abone();
  };
}

/** Uygulama arka plana giderken hemen yaz — iOS süreci öldürebilir, bekleyen yazma kaybolur. */
export function flushOfflineCache(qc: QueryClient): void {
  diskeYaz(qc);
}
