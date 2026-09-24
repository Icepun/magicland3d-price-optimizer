import { QueryClient, QueryClientProvider, focusManager, type Query } from "@tanstack/react-query";
import { type ReactNode, useEffect, useState } from "react";
import { AppState } from "react-native";

import { hbDiskDeposu } from "@/lib/api/hb-detay-onbellek";
import { hbDetayDeposunuKur } from "@/lib/api/hepsiburada";
import {
  flushOfflineCache,
  loadOfflineCache,
  startOfflineCachePersist,
} from "@/lib/offline-cache";

/**
 * UYGULAMA ÖNE GELİNCE TAZELENEN SORGULAR — dar ve bilinçli liste.
 *
 * React Query uygulamanın öne geldiğini KENDİLİĞİNDEN bilmiyor (React Native'de pencere odağı
 * yok). Bir tur hiçbir şey tazelenmiyordu: telefona bir saat sonra dönünce siparişler, zil ve
 * yazıcı durumu eski kalıyor, aşağı çekip yenilemek gerekiyordu. Artık yalnız bu listedekiler
 * ve yalnız ESKİMİŞLERSE (her sorgunun kendi `staleTime`'ı) yenilenir — "agresif yenileme yok"
 * ilkesi korunur; ağır ürün listesi burada değil (stoklar ayrıca `fresh-stocks` ile gelir).
 */
const ODAKTA_TAZELENEN = new Set(["orders", "notifications", "printer-snapshots", "prep-done"]);

export function odaktaTazelensinMi(query: Pick<Query, "queryKey">): boolean {
  const kok = query.queryKey[0];
  return typeof kok === "string" && ODAKTA_TAZELENEN.has(kok);
}

/** AppState → React Query odak bilgisi (resmî React Native tarifi). Uygulama başına bir kez. */
focusManager.setEventListener((odaklandi) => {
  const sub = AppState.addEventListener("change", (durum) => odaklandi(durum === "active"));
  return () => sub.remove();
});

/**
 * react-query sağlayıcısı — masaüstüyle aynı veri-çekme modeli.
 * Mobilde agresif refetch YOK; yalnız yukarıdaki dar liste öne gelişte ve eskimişse yenilenir.
 */
export function AppQueryProvider({ children }: { children: ReactNode }) {
  /**
   * İstemci İLK ÇİZİMDEN ÖNCE diskteki önbellekle doldurulur (useState başlatıcısı içinde):
   * ekranlar veriyi ilk karede bulur, boş iskelet flaşı olmaz. Yükleme senkron ve küçük bir
   * dosya okuması; ölçülebilir bir gecikme yaratmıyor.
   */
  const [client] = useState(() => {
    const qc = new QueryClient({
        defaultOptions: {
          queries: {
            // Akıcılık: ekran geçişlerinde gereksiz yeniden çekme YOK (cache kullan).
            // Tazeleme: elle aşağı çek (pull-to-refresh) ya da mutasyon invalidasyonu.
            staleTime: 5 * 60_000,
            gcTime: 30 * 60_000,
            retry: 1,
            refetchOnWindowFocus: (q) => odaktaTazelensinMi(q),
            refetchOnReconnect: false,
          },
        },
    });
    loadOfflineCache(qc);
    // HB sipariş detayları diskten: soğuk açılışta ~40 detay isteği yerine yalnız yenileri.
    hbDetayDeposunuKur(hbDiskDeposu);
    return qc;
  });

  // Değişimleri diske yaz + arka plana geçerken hemen boşalt (iOS süreci öldürebilir).
  useEffect(() => {
    const durdur = startOfflineCachePersist(client);
    const sub = AppState.addEventListener("change", (st) => {
      if (st !== "active") flushOfflineCache(client);
    });
    return () => {
      durdur();
      sub.remove();
    };
  }, [client]);

  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
