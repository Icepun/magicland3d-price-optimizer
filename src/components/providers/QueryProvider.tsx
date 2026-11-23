"use client";

import { QueryClient, QueryClientProvider, focusManager } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { gizlilikAbone, pencereGizliMi, pencereSinyaliVar } from "@/lib/pencere-gorunur";
import { StartupSync } from "./StartupSync";
import { GlobalBusyOverlay } from "@/components/ui/global-busy-overlay";
import { PerfHud } from "@/components/perf/PerfHud";

export function QueryProvider({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // Navigasyonda gereksiz refetch'i kes: ekranlar arası geçiş cache'ten ANINDA gelir
            // (yeniden fetch+parse+render yok). Kendi değişikliklerin mutation invalidate ile
            // zaten yansır; ağır ekranlar kalıcı disk SWR cache'inden anında okunur.
            // Bulut tazelemesi asenkron, refetchInterval'lı sorgular çalışmaya devam eder.
            staleTime: 5 * 60_000, // 5 dk taze say
            // 10 dk: kullanılmayan (observer'sız) sorgular bu sürede toplanır. 30dk idi →
            // çok sayıda 368-ürünlük büyük payload heap'te birikip 15-20dk'da GC baskısı +
            // jank yaratıyordu. 10dk hâlâ ekranlar arası anında geçişe yetiyor.
            gcTime: 10 * 60_000,
            retry: false,
            refetchOnMount: false, // mount'ta otomatik refetch yok → cache anında
            refetchOnWindowFocus: false,
            refetchOnReconnect: false,
            /**
             * YEREL SUNUCU — istekler bu bilgisayardaki uygulamaya gider; internet kopukken de
             * ulaşılır. Varsayılan "online" kipinde Wi-Fi düşünce sorgular "duraklatılıp" iskelet
             * sonsuza kalıyordu (Ürünler, Siparişler, pencereler — her sayfada tek tek düzeltiliyordu).
             */
            networkMode: "always",
          },
          mutations: {
            /**
             * Aynı sebep, ama burada TEHLİKELİ: Wi-Fi kopukken basılan "Duraklat"/"İptal" kuyruğa
             * alınıp ağ dakikalar sonra gelince KENDİLİĞİNDEN gönderiliyordu — baskı beklenmedik
             * anda duruyordu (denetim, 23 Kas 2026). Yerel sunucu yazıcıya ulaşamazsa hatayı
             * kendisi döner; komut ya şimdi gider ya hiç.
             */
            networkMode: "always",
          },
        },
      })
  );

  // Masaüstünde "odak" = pencere GERÇEKTEN görünür (tepside / küçültülmüş / ekran kilitli değil).
  // Aralıklı yoklamalar odak yokken kendiliğinden durur; pencere geri gelince, bunu isteyen
  // sorgular (yazıcı paneli, zil) hemen tazelenir. Tarayıcıda varsayılan davranış korunur.
  useEffect(() => {
    if (!pencereSinyaliVar()) return;
    focusManager.setEventListener((odakla) => {
      const bildir = () => odakla(!pencereGizliMi());
      const birak = gizlilikAbone(bildir);
      bildir();
      return birak;
    });
  }, []);

  // Bilgisayar uyanınca sayfa silinmez; görünen bütün veriler arka planda tazelenir.
  useEffect(() => {
    const kopru = typeof window === "undefined" ? undefined : window.trendyolPriceOptimizer?.uygulama;
    if (!kopru) return;
    return kopru.onUyanis(() => {
      void queryClient.invalidateQueries();
    });
  }, [queryClient]);

  return (
    <QueryClientProvider client={queryClient}>
      <StartupSync />
      {children}
      <GlobalBusyOverlay />
      <PerfHud />
    </QueryClientProvider>
  );
}
