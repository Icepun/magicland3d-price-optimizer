import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type ReactNode, useEffect, useState } from "react";
import { AppState } from "react-native";

import {
  flushOfflineCache,
  loadOfflineCache,
  startOfflineCachePersist,
} from "@/lib/offline-cache";

/**
 * react-query sağlayıcısı — masaüstüyle aynı veri-çekme modeli.
 * Mobilde agresif refetch YOK (pencere odağı/interval), sadece elle/mount yenileme.
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
            refetchOnWindowFocus: false,
            refetchOnReconnect: false,
          },
        },
    });
    loadOfflineCache(qc);
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
