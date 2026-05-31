import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";

/**
 * react-query sağlayıcısı — masaüstüyle aynı veri-çekme modeli.
 * Mobilde agresif refetch YOK (pencere odağı/interval), sadece elle/mount yenileme.
 */
export function AppQueryProvider({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
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
      })
  );
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
