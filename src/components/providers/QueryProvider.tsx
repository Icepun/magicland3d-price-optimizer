"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { StartupSync } from "./StartupSync";

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
            gcTime: 30 * 60_000, // 30 dk cache'te tut
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
    </QueryClientProvider>
  );
}
