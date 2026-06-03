"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
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
            // zaten yansır; çok-cihaz tazeliği için embedded replica ~60sn'de senkronlanır +
            // manuel yenile / refetchInterval'lı query'ler (printer, bildirim) çalışmaya devam eder.
            staleTime: 5 * 60_000, // 5 dk taze say
            // 10 dk: kullanılmayan (observer'sız) sorgular bu sürede toplanır. 30dk idi →
            // çok sayıda 368-ürünlük büyük payload heap'te birikip 15-20dk'da GC baskısı +
            // jank yaratıyordu. 10dk hâlâ ekranlar arası anında geçişe yetiyor.
            gcTime: 10 * 60_000,
            retry: false,
            refetchOnMount: false, // mount'ta otomatik refetch yok → cache anında
            refetchOnWindowFocus: false,
            refetchOnReconnect: false,
          },
        },
      })
  );

  return (
    <QueryClientProvider client={queryClient}>
      <StartupSync />
      {children}
      <GlobalBusyOverlay />
      <PerfHud />
    </QueryClientProvider>
  );
}
